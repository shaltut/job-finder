// Hands the database between two machines that never run at once, through a cloud-synced folder.
// See docs/superpowers/specs/2026-10-03-cross-machine-sync-design.md.
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

export function readLocalGen(stateFile: string): number {
  try {
    return (JSON.parse(readFileSync(stateFile, 'utf8')) as { gen: number }).gen ?? 0
  } catch {
    return 0
  }
}
const writeLocalGen = (stateFile: string, gen: number) => writeJson(stateFile, { gen })

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
    assertNoStrays(p.syncDir)
    copyFileSync(snapFile(p), tmp)
    if (statSync(tmp).size !== remote!.size || sha256(tmp) !== remote!.sha256) {
      throw new Error(`the gen ${remote!.gen} snapshot is not yet downloaded (it does not match sync.json)`)
    }
    const check = new Database(tmp, { readonly: true, fileMustExist: true })
    try {
      const r = check.pragma('integrity_check', { simple: true })
      if (r !== 'ok') throw new Error(`integrity_check: ${r}`)
    } finally {
      check.close()
    }
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

// One heartbeat file per machine, so no two machines ever write the same file — a shared one turns a
// heartbeat that lands mid-push into a sync-client conflict copy.
const safeHost = (host: string) => host.replace(/[^\w.-]/g, '_')

export function heartbeat(p: HandoffPaths, host: string, now = new Date()) {
  if (existsSync(p.syncDir)) writeJson(join(p.syncDir, `heartbeat-${safeHost(host)}.json`), { at: now.toISOString() })
}

/** Another machine wrote a heartbeat in the last 5 minutes. A warning only: a crashed machine must not lock anyone out. */
export function otherActive(syncDir: string, host: string, now = new Date()): boolean {
  if (!existsSync(syncDir)) return false
  const mine = `heartbeat-${safeHost(host)}.json`
  return readdirSync(syncDir).some((f) => {
    if (!f.startsWith('heartbeat-') || !f.endsWith('.json') || f === mine) return false
    try {
      return now.getTime() - Date.parse((JSON.parse(readFileSync(join(syncDir, f), 'utf8')) as { at: string }).at) < ACTIVE_MS
    } catch {
      return false
    }
  })
}
