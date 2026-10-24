// Hands the database between two machines through a cloud-synced folder. Both may run at once, but only
// one LEADS (runs jobs, takes writes, pushes); the other is on standby and follows the leader's snapshots
// live — see nextStep() below and docs/superpowers/specs/2026-10-24-live-standby-design.md. The file
// hand-off itself: docs/superpowers/specs/2026-10-03-cross-machine-sync-design.md.
//
// The live file never sits in the synced folder: a sync client copies the main file while commits
// still sit in -wal (the failure that cost the old file-copy backup 12 posts on 2026-09-25). Snapshots
// go through VACUUM INTO, and `gen` in sync.json makes every push a compare-and-swap, so a machine
// that booted before OneDrive delivered the newer snapshot can never overwrite it.
//
// The sync client delivers files in no fixed order — the 1 KB sync.json usually lands before the 8 MB
// snapshot — so sync.json carries the snapshot's sha256 and a pull refuses a snapshot that does not
// match it. Otherwise a machine would pull the previous generation's data stamped with the new gen,
// and its next push would erase the other machine's last session.
//
// No import of ./db: that module opens the database on import, and pull() must run before it does.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

export interface SyncMeta { gen: number, host: string, pushedAt: string, sha256: string, size: number }
export interface HandoffPaths { db: string, cvDir: string, stateFile: string, backupsDir: string, syncDir: string }

const ACTIVE_MS = 5 * 60_000
const snapFile = (p: HandoffPaths) => join(p.syncDir, 'jobfinder.db')
const metaFile = (syncDir: string) => join(syncDir, 'sync.json')

export function readMeta(syncDir: string): SyncMeta | null {
  try {
    return JSON.parse(readFileSync(metaFile(syncDir), 'utf8')) as SyncMeta
  } catch {
    return null // missing folder, missing file, or a half-synced one: nothing to pull
  }
}

// flush: NTFS commits the rename before the data, so a crash after an unflushed write leaves the file at
// full size and all NUL — sync.json, 2026-10-13, which then blocked every push until rebuilt by hand
function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { flush: true })
  renameSync(`${file}.tmp`, file)
}

export type Role = 'active' | 'standby' | 'claiming' | 'yielding'
/** data/sync-state.json — the gen, and the role, which must outlive a dev worker rebuild (globalThis does not). */
export interface LocalState { gen: number, role?: Role, since?: string }

export function readLocal(stateFile: string): LocalState {
  try {
    return { gen: 0, ...(JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<LocalState>) }
  } catch {
    return { gen: 0 }
  }
}
export const readLocalGen = (stateFile: string): number => readLocal(stateFile).gen ?? 0
export const writeLocal = (stateFile: string, patch: Partial<LocalState>) => writeJson(stateFile, { ...readLocal(stateFile), ...patch })
const writeLocalGen = (stateFile: string, gen: number) => writeLocal(stateFile, { gen })

export const shouldPull = (remote: SyncMeta | null, localGen: number) => !!remote && remote.gen > localGen
export const canPush = (remote: SyncMeta | null, localGen: number) => (remote?.gen ?? 0) === localGen

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-')
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** VACUUM INTO through a fresh read-only connection, written beside the target and renamed over it. */
function vacuumInto(src: string, target: string) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  rmSync(tmp, { force: true })
  const db = new Database(src, { readonly: true, fileMustExist: true })
  try {
    db.prepare('VACUUM INTO ?').run(tmp)
  } finally {
    db.close()
  }
  renameSync(tmp, target)
}

/**
 * A safety copy in backups/. `pre-pull` and `conflict` keep the newest 5 of their kind (backup.ts
 * prunes only jobfinder-*.db); `pre-sync` — this machine's own history from before its first pull —
 * is never pruned, because it is what scripts/merge-db.ts reads, and nobody merges on day one.
 */
function safetyCopy(p: HandoffPaths, kind: 'pre-sync' | 'pre-pull' | 'conflict', now: Date) {
  vacuumInto(p.db, join(p.backupsDir, `${kind}-${stamp(now)}.db`))
  if (kind === 'pre-sync') return
  const old = readdirSync(p.backupsDir).filter(f => f.startsWith(`${kind}-`) && f.endsWith('.db')).sort().slice(0, -5)
  old.forEach(f => rmSync(join(p.backupsDir, f)))
}

const OWN = new Set(['jobfinder.db', 'jobfinder.db.tmp', 'sync.json', 'sync.json.tmp'])

/**
 * A sync client's conflict copy of one of our two shared files (`sync-<machine>.json`,
 * `jobfinder-<machine>.db`): both machines pushed the same generation — e.g. Sync now, then the laptop
 * closed before OneDrive finished uploading. The data has forked; neither side may pull or push until
 * the owner picks one (merge the other with scripts/merge-db.ts) and deletes the stray. Only names
 * shaped like ours count, so `.DS_Store`, `desktop.ini`, `cv/` and the heartbeat files never do.
 */
export function strays(syncDir: string): string[] {
  if (!existsSync(syncDir)) return []
  return readdirSync(syncDir).filter(f => (f.startsWith('jobfinder') || f.startsWith('sync')) && !OWN.has(f))
}
function assertNoStrays(syncDir: string) {
  const s = strays(syncDir)
  if (s.length) throw new Error(`conflict copy in the sync folder: ${s.join(', ')} — merge it with scripts/merge-db.ts, delete it, restart`)
}

/**
 * Copies files that are missing, or differ in size, or are older than the source. Never deletes: a
 * mirror is not a sync. The copy keeps the source's mtime — without that every copy is newer than its
 * source, and the two directions would re-copy each other's files on every push.
 */
export function mirror(from: string, to: string): number {
  if (!existsSync(from)) return 0
  let copied = 0
  for (const name of readdirSync(from, { recursive: true }) as string[]) {
    const src = join(from, name)
    const st = statSync(src)
    if (!st.isFile()) continue
    const dst = join(to, name)
    const d = existsSync(dst) ? statSync(dst) : null
    // 2s of slack: utimes sets milliseconds while NTFS keeps 100ns, and sync clients round further
    if (d && d.size === st.size && d.mtimeMs >= st.mtimeMs - 2000) continue
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    utimesSync(dst, st.atime, st.mtime)
    copied++
  }
  return copied
}

/** Copies the remote snapshot to `tmp` and proves it is the one sync.json describes, and readable. */
function fetchSnapshot(p: HandoffPaths, remote: SyncMeta, tmp: string) {
  assertNoStrays(p.syncDir)
  copyFileSync(snapFile(p), tmp)
  if (statSync(tmp).size !== remote.size || sha256(tmp) !== remote.sha256) {
    throw new Error(`the gen ${remote.gen} snapshot is not yet downloaded (it does not match sync.json)`)
  }
  const check = new Database(tmp, { readonly: true, fileMustExist: true })
  try {
    const r = check.pragma('integrity_check', { simple: true })
    if (r !== 'ok') throw new Error(`integrity_check: ${r}`)
  } finally {
    check.close()
  }
}

/**
 * Runs at boot, before any connection to `p.db` exists. A failure keeps the local file: the caller
 * must then disable pushing, because a machine that could not see the newest snapshot must not
 * publish its own over it.
 */
export function pull(p: HandoffPaths, now = new Date()): { pulled: boolean, gen: number, error?: string, warning?: string } {
  const remote = readMeta(p.syncDir)
  const local = readLocalGen(p.stateFile)
  if (!shouldPull(remote, local)) return { pulled: false, gen: local }
  const tmp = `${p.db}.pull.tmp`
  try {
    fetchSnapshot(p, remote!, tmp)
    if (existsSync(p.db)) {
      // closing the last connection checkpoints the WAL into the main file, so nothing deleted below
      // is the only copy of a commit if the rename then fails
      new Database(p.db).close()
      safetyCopy(p, local === 0 ? 'pre-sync' : 'pre-pull', now)
    }
    rmSync(`${p.db}-wal`, { force: true })
    rmSync(`${p.db}-shm`, { force: true })
    renameSync(tmp, p.db)
    writeLocalGen(p.stateFile, remote!.gen) // straight after the swap: the next boot must not pull over this session
  } catch (e) {
    rmSync(tmp, { force: true })
    return { pulled: false, gen: local, error: (e as Error).message }
  }
  try {
    mirror(join(p.syncDir, 'cv'), p.cvDir)
    return { pulled: true, gen: remote!.gen }
  } catch (e) {
    // a CV that did not arrive costs a tailored attachment (followUpAttachment falls back), never data
    return { pulled: true, gen: remote!.gen, warning: `CV files not copied: ${(e as Error).message}` }
  }
}

/**
 * `init` seeds an empty folder. It is never implied: a folder with no sync.json looks exactly like one
 * whose sync.json OneDrive has not delivered yet, and publishing this machine's old history into the
 * second case forks the data.
 */
export function push(p: HandoffPaths, host: string, now = new Date(), opts: { init?: boolean } = {}): { ok: true, gen: number } | { ok: false, conflict: SyncMeta } {
  // A missing folder means OneDrive has not delivered it yet (or is not signed in).
  if (!existsSync(p.syncDir)) throw new Error(`sync folder missing: ${p.syncDir} — create it once on the first machine`)
  assertNoStrays(p.syncDir)
  const remote = readMeta(p.syncDir)
  const local = readLocalGen(p.stateFile)
  if (!remote && local > 0) {
    throw new Error(existsSync(metaFile(p.syncDir))
      ? 'sync.json is present but not valid JSON — OneDrive mid-sync, or a crash zeroed it; if it repeats, rebuild it (CLAUDE.md, "Two machines")'
      : 'sync.json missing — OneDrive may be mid-sync; retrying')
  }
  if (!remote && !opts.init) throw new Error('the sync folder has no history yet — press Sync now to init it from this machine, or wait for the other machine\'s to arrive')
  if (!canPush(remote, local)) {
    // keep this machine's work recoverable before it stops publishing
    safetyCopy(p, 'conflict', now)
    return { ok: false, conflict: remote! }
  }
  // built locally and hashed before it enters the synced folder, so the client never uploads a half-written file
  const local_tmp = `${p.db}.push.tmp`
  vacuumInto(p.db, local_tmp)
  const meta = { gen: local + 1, host, pushedAt: now.toISOString(), sha256: sha256(local_tmp), size: statSync(local_tmp).size } satisfies SyncMeta
  copyFileSync(local_tmp, `${snapFile(p)}.tmp`)
  rmSync(local_tmp, { force: true })
  renameSync(`${snapFile(p)}.tmp`, snapFile(p))
  mirror(p.cvDir, join(p.syncDir, 'cv'))
  writeJson(metaFile(p.syncDir), meta)
  writeLocalGen(p.stateFile, meta.gen)
  return { ok: true, gen: meta.gen }
}

/**
 * The standby's pull: the newer snapshot replaces the LIVE database's rows in place, because every module
 * holds db.ts's open connection and the file cannot be swapped under it. All deletes before all inserts —
 * applications and post_requirements cascade from posts — inside one transaction with the foreign keys
 * deferred to the commit. Only shared columns, so a snapshot one migration apart still lands.
 *
 * Safe only because a machine on standby runs no job (pump() starts nothing, the write gate refuses the
 * UI), so no openWritableDb() connection writes underneath. `job_queue` is never copied: it is per
 * machine, and resuming the other machine's jobs drafted the same recruiters twice. `keep` takes a
 * pre-pull copy first — for a standby holding work its final push did not get out.
 */
export function livePull(live: Database.Database, p: HandoffPaths, opts: { keep?: boolean } = {}, now = new Date()): { pulled: boolean, gen: number, error?: string } {
  const remote = readMeta(p.syncDir)
  const local = readLocalGen(p.stateFile)
  if (!shouldPull(remote, local)) return { pulled: false, gen: local }
  const tmp = `${p.db}.pull.tmp`
  try {
    fetchSnapshot(p, remote!, tmp)
    if (opts.keep) safetyCopy(p, 'pre-pull', now)
    live.prepare('ATTACH DATABASE ? AS snap').run(tmp)
    try {
      const tables = (schema: string) => (live.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name <> 'job_queue'`).all() as { name: string }[]).map(t => t.name)
      const cols = (t: string, schema: string) => (live.prepare('SELECT name FROM pragma_table_info(?, ?)').all(t, schema) as { name: string }[]).map(c => c.name)
      const theirs = new Set(tables('snap'))
      const both = tables('main').filter(t => theirs.has(t))
      live.transaction(() => {
        live.pragma('defer_foreign_keys = ON')
        for (const t of both) live.prepare(`DELETE FROM main."${t}"`).run()
        for (const t of both) {
          const have = new Set(cols(t, 'snap'))
          const shared = cols(t, 'main').filter(c => have.has(c)).map(c => `"${c}"`).join(', ')
          if (shared) live.prepare(`INSERT INTO main."${t}" (${shared}) SELECT ${shared} FROM snap."${t}"`).run()
        }
      })()
    } finally {
      live.exec('DETACH DATABASE snap')
    }
    writeLocalGen(p.stateFile, remote!.gen)
  } catch (e) {
    return { pulled: false, gen: local, error: (e as Error).message }
  } finally {
    rmSync(tmp, { force: true })
  }
  try {
    mirror(join(p.syncDir, 'cv'), p.cvDir)
  } catch { /* a CV that did not arrive costs a tailored attachment, never data (see pull) */ }
  return { pulled: true, gen: remote!.gen }
}

// One heartbeat file per machine, so no two machines ever write the same file — a shared one turns a
// heartbeat that lands mid-push into a sync-client conflict copy. The heartbeat is also the lease: it
// carries this machine's role, when it last became the leader, and the gen it holds.
const safeHost = (host: string) => host.replace(/[^\w.-]/g, '_')

export interface Peer { host: string, at: string, role: Role, since: string, gen: number }

export function heartbeat(p: HandoffPaths, host: string, now = new Date(), lease: { role: Role, since: string, gen: number } = { role: 'active', since: '', gen: 0 }) {
  if (existsSync(p.syncDir)) writeJson(join(p.syncDir, `heartbeat-${safeHost(host)}.json`), { at: now.toISOString(), host, ...lease })
}

/**
 * The other machine's heartbeat, if it is under 5 minutes old. A heartbeat from a build before the lease
 * carries no role and is read as `active`: that build never yields, so it must be treated as leading.
 */
export function livePeer(syncDir: string, host: string, now = new Date()): Peer | null {
  if (!existsSync(syncDir)) return null
  const mine = `heartbeat-${safeHost(host)}.json`
  let best: Peer | null = null
  for (const f of readdirSync(syncDir)) {
    if (!f.startsWith('heartbeat-') || !f.endsWith('.json') || f === mine) continue
    try {
      const b = JSON.parse(readFileSync(join(syncDir, f), 'utf8')) as Partial<Peer>
      if (!b.at || now.getTime() - Date.parse(b.at) >= ACTIVE_MS) continue
      const peer: Peer = { host: b.host ?? f.slice(10, -5), at: b.at, role: b.role ?? 'active', since: b.since ?? '', gen: b.gen ?? 0 }
      if (!best || peer.at > best.at) best = peer
    } catch { /* half-synced file: skip it this tick */ }
  }
  return best
}

/** Another machine wrote a heartbeat in the last 5 minutes. */
export const otherActive = (syncDir: string, host: string, now = new Date()): boolean => !!livePeer(syncDir, host, now)

/** Which machine leads when a fresh process starts: standby whenever a live peer leads or is taking over. */
export const bootRole = (peer: Peer | null): Role => peer && peer.role !== 'standby' ? 'standby' : 'active'

export interface Me { host: string, role: Role, since: string, busy: boolean, localGen: number, remoteGen: number | null }
export interface Step { role: Role, since?: string, stop?: true, finish?: true, pull?: true }

/**
 * One tick of the lease, run every 30 s by server/plugins/handoff.ts. Pure, so every transition is tested.
 *
 * - active → yielding when the peer claims, when the peer also leads and became leader later (a laptop
 *   that slept through a take-over wakes up still "active"), or when a newer gen than ours appeared — and
 *   the leader never pulls under its own running jobs, so it yields first and pulls from standby.
 * - yielding: stops every lane (`stop`), waits until none runs, then pushes its last changes (`finish`).
 * - standby follows each newer snapshot (`pull`) and never leads on its own: a stale peer heartbeat looks
 *   the same whether the other machine closed or this one's OneDrive stopped delivering. The button does.
 * - claiming (the Use-this-machine button): waits for the peer to stand down AND for its final snapshot
 *   (`remoteGen >= peer.gen`) to arrive, then pulls and leads. With no live peer it leads at once.
 *
 * Ties (both standby, both claiming, both leading since the same instant) go to the lower host name.
 * ponytail: the lease travels through OneDrive, so a take-over waits on its delivery (a minute or two),
 * and a claim on a peer whose heartbeat is stale (asleep, offline) proceeds at once — if it was only
 * paused it leads too until its next tick reads the newer leader. That window is the one place two
 * machines can both run jobs; a real lock needs a server both can reach.
 */
export function nextStep(me: Me, peer: Peer | null, now = new Date()): Step {
  const newer = (me.remoteGen ?? 0) > me.localGen
  const lead = (): Step => ({ role: 'active', since: now.toISOString(), ...(newer ? { pull: true as const } : {}) })
  const peerWins = (p: Peer) => p.since > me.since || (p.since === me.since && p.host < me.host)
  switch (me.role) {
    case 'active':
      if (peer?.role === 'claiming' || (peer?.role === 'active' && peerWins(peer)) || newer) return { role: 'yielding', stop: true }
      return { role: 'active' }
    case 'yielding':
      return me.busy ? { role: 'yielding' } : { role: 'standby', finish: true }
    case 'standby':
      // never on a missing peer: that is also what THIS machine sees when its own OneDrive stopped
      // delivering, and leading then would push into a stale folder and fork it (a sync-client stray)
      if (peer?.role === 'standby' && me.host < peer.host) return lead()
      return newer ? { role: 'standby', pull: true } : { role: 'standby' }
    case 'claiming':
      if (!peer) return lead()
      if (peer.role === 'standby' && (me.remoteGen ?? 0) >= peer.gen) return lead()
      if (peer.role === 'claiming' && peer.host < me.host) return { role: 'standby' }
      return { role: 'claiming' }
  }
}

/** The write gate on standby: every write through the API is refused but the hand-off's own controls. */
export const standbyRefuses = (role: Role, method: string, path: string): boolean =>
  role !== 'active' && method !== 'GET' && method !== 'HEAD' && path.startsWith('/api/') && !path.startsWith('/api/sync')
