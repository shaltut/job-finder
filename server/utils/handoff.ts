// Hands the database between two machines that never run at once, through a cloud-synced folder.
// See docs/superpowers/specs/2026-10-03-cross-machine-sync-design.md.
//
// The live file never sits in the synced folder: a sync client copies the main file while commits
// still sit in -wal (the failure that cost the old file-copy backup 12 posts on 2026-09-25). Snapshots
// go through VACUUM INTO, and `gen` in sync.json makes every push a compare-and-swap, so a machine
// that booted before OneDrive delivered the newer snapshot can never overwrite it.
//
// No import of ./db: that module opens the database on import, and pull() must run before it does.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

export interface SyncMeta { gen: number, host: string, pushedAt: string, heartbeatAt: string }
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

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2))
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
export const otherActive = (remote: SyncMeta | null, host: string, now = new Date()) =>
  !!remote && remote.host !== host && now.getTime() - Date.parse(remote.heartbeatAt) < ACTIVE_MS

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-')

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

/** A safety copy in backups/, keeping the newest 5 of its kind — backup.ts prunes only jobfinder-*.db. */
function safetyCopy(p: HandoffPaths, kind: 'pre-pull' | 'conflict', now: Date) {
  vacuumInto(p.db, join(p.backupsDir, `${kind}-${stamp(now)}.db`))
  const old = readdirSync(p.backupsDir).filter(f => f.startsWith(`${kind}-`) && f.endsWith('.db')).sort().slice(0, -5)
  old.forEach(f => rmSync(join(p.backupsDir, f)))
}

const OWN = new Set(['jobfinder.db', 'jobfinder.db.tmp', 'sync.json', 'sync.json.tmp', 'cv'])

/**
 * Anything else in the folder is a sync client's conflict copy (`sync-<machine>.json`,
 * `jobfinder-<machine>.db`): both machines pushed the same generation — e.g. Sync now, then the laptop
 * closed before OneDrive finished uploading. The data has forked; neither side may pull or push until
 * the owner picks one (merge the other with scripts/merge-db.ts) and deletes the stray.
 */
export function strays(syncDir: string): string[] {
  return existsSync(syncDir) ? readdirSync(syncDir).filter(f => !OWN.has(f)) : []
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
export function pull(p: HandoffPaths, now = new Date()): { pulled: boolean, gen: number, error?: string } {
  const remote = readMeta(p.syncDir)
  const local = readLocalGen(p.stateFile)
  if (!shouldPull(remote, local)) return { pulled: false, gen: local }
  const tmp = `${p.db}.pull.tmp`
  try {
    assertNoStrays(p.syncDir)
    copyFileSync(snapFile(p), tmp)
    const check = new Database(tmp, { readonly: true, fileMustExist: true })
    try {
      const r = check.pragma('integrity_check', { simple: true })
      if (r !== 'ok') throw new Error(`integrity_check: ${r}`)
    } finally {
      check.close()
    }
    if (existsSync(p.db)) safetyCopy(p, 'pre-pull', now)
    rmSync(`${p.db}-wal`, { force: true })
    rmSync(`${p.db}-shm`, { force: true })
    renameSync(tmp, p.db)
    mirror(join(p.syncDir, 'cv'), p.cvDir)
    writeLocalGen(p.stateFile, remote!.gen)
    return { pulled: true, gen: remote!.gen }
  } catch (e) {
    rmSync(tmp, { force: true })
    return { pulled: false, gen: local, error: (e as Error).message }
  }
}

export function push(p: HandoffPaths, host: string, now = new Date()): { ok: true, gen: number } | { ok: false, conflict: SyncMeta } {
  // A missing folder means OneDrive has not delivered it yet (or is not signed in). Seeding it from here
  // would publish this machine's old DB as gen 1 beside the real history and fork sync.json.
  if (!existsSync(p.syncDir)) throw new Error(`sync folder missing: ${p.syncDir} — create it once on the first machine`)
  assertNoStrays(p.syncDir)
  const remote = readMeta(p.syncDir)
  const local = readLocalGen(p.stateFile)
  if (!canPush(remote, local)) {
    // keep this machine's work recoverable before it stops publishing
    safetyCopy(p, 'conflict', now)
    return { ok: false, conflict: remote! }
  }
  vacuumInto(p.db, snapFile(p))
  mirror(p.cvDir, join(p.syncDir, 'cv'))
  const gen = local + 1
  const iso = now.toISOString()
  writeJson(metaFile(p.syncDir), { gen, host, pushedAt: iso, heartbeatAt: iso } satisfies SyncMeta)
  writeLocalGen(p.stateFile, gen)
  return { ok: true, gen }
}

/** Marks this machine active, only while it owns the current generation — never over a newer one. */
export function heartbeat(p: HandoffPaths, host: string, now = new Date()) {
  const remote = readMeta(p.syncDir)
  if (!remote || remote.gen !== readLocalGen(p.stateFile)) return
  writeJson(metaFile(p.syncDir), { ...remote, host, heartbeatAt: now.toISOString() })
}
