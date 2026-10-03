# Cross-machine sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One job-finder history across a Windows PC and a Mac that never run at the same time, handed off through a OneDrive folder.

**Architecture:** The live SQLite file stays local. A pure-ish module `server/utils/handoff.ts` pulls a newer snapshot at boot (before `db.ts` opens the file) and pushes a `VACUUM INTO` snapshot plus a `data/cv/` mirror every 2 minutes when the DB changed, guarded by a generation counter in `sync.json` so a stale machine can never overwrite a newer snapshot. Tailored-CV paths are stored with `/` so they resolve on macOS.

**Tech Stack:** Node 22 (type stripping), better-sqlite3, Nitro plugins + API routes, Nuxt UI v4, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-03-cross-machine-sync-design.md`

## Global Constraints

- Sync is **off unless `JOBFINDER_SYNC_DIR` is set**; unset = behaviour identical to today.
- Snapshots are `VACUUM INTO` only — never a file copy of a live WAL database.
- A push writes only when `remote.gen === local.gen`; otherwise conflict, no write.
- A failed boot pull keeps the local DB and disables pushing for the session.
- Mirroring copies, never deletes.
- Secrets (`.env`, `google-oauth.json`, `gmail-token.json`) and `profile/` are never synced.
- Paths written to the DB use `/`.
- **Before any edit under `server/`**: `curl -s http://127.0.0.1:3939/api/job` must show no running or queued job (a server edit restarts the Nitro worker and drops them).
- No new dependencies.

## Review Focus

1. **First boot on the Mac with its own old, separate DB** → its records must not vanish: the pre-pull backup holds them, and Task 6 merges them in once.
2. **OneDrive has not finished downloading when the Mac boots** (remote gen still old) → the Mac starts on local data; its first push must be refused once the newer `sync.json` arrives, not overwrite it. Pinned in Task 1 (`stale push refused`).
3. **Snapshot is a truncated/partial file (OneDrive mid-download)** → pull must fail closed: local DB kept, pushing disabled. Pinned in Task 1 (`corrupt snapshot`).
4. **Old `contacts.cv_path` rows with backslashes on the Mac** → follow-up attaches the tailored CV, not the uploaded one. Pinned in Task 3.
5. **Sync folder missing** (OneDrive not signed in, or the Mac boots before OneDrive has created it) → pull treats it as nothing to pull, and push **refuses** (`sync folder missing`) rather than publishing this machine's old DB as gen 1 and forking `sync.json`. The folder is created once by hand on the first machine. Pinned in Task 1 (`missing folder`).

---

### Task 1: `handoff.ts` — pull, push, mirror (pure logic + file ops)

**Files:**
- Create: `server/utils/handoff.ts`
- Test: `test/handoff.test.ts`

**Interfaces:**
- Produces:
  - `interface SyncMeta { gen: number, host: string, pushedAt: string, heartbeatAt: string }`
  - `interface HandoffPaths { db: string, cvDir: string, stateFile: string, backupsDir: string, syncDir: string }`
  - `readMeta(syncDir: string): SyncMeta | null`
  - `readLocalGen(stateFile: string): number`
  - `shouldPull(remote: SyncMeta | null, localGen: number): boolean`
  - `canPush(remote: SyncMeta | null, localGen: number): boolean`
  - `pull(p: HandoffPaths, now?: Date): { pulled: boolean, gen: number, error?: string }`
  - `push(p: HandoffPaths, host: string, now?: Date): { ok: true, gen: number } | { ok: false, conflict: SyncMeta }`
  - `heartbeat(p: HandoffPaths, host: string, now?: Date): void`
  - `otherActive(remote: SyncMeta | null, host: string, now?: Date): boolean`
  - `mirror(from: string, to: string): number` (files copied)
  - `strays(syncDir: string): string[]` — sync-client conflict copies; `pull` returns an error and `push` throws while any exist

- [ ] **Step 1: Write the failing test**

```ts
// test/handoff.test.ts
// Two temp dirs stand in for two machines sharing one OneDrive folder. The machines never run at once,
// which is the only reason a whole-file hand-off is enough.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { canPush, mirror, otherActive, pull, push, readLocalGen, readMeta, shouldPull, strays, type HandoffPaths } from '../server/utils/handoff.ts'

function machine(root: string, name: string, syncDir: string): HandoffPaths {
  const base = join(root, name)
  mkdirSync(join(base, 'data', 'cv'), { recursive: true })
  return { db: join(base, 'data', 'jobfinder.db'), cvDir: join(base, 'data', 'cv'), stateFile: join(base, 'data', 'sync-state.json'), backupsDir: join(base, 'backups'), syncDir }
}
function insert(file: string, key: string) {
  const d = new Database(file)
  d.pragma('journal_mode = WAL')
  d.exec('CREATE TABLE IF NOT EXISTS posts (key TEXT PRIMARY KEY)')
  d.prepare('INSERT INTO posts VALUES (?)').run(key)
  d.close()
}
function keys(file: string): string[] {
  const d = new Database(file, { readonly: true })
  try {
    return (d.prepare('SELECT key FROM posts ORDER BY key').all() as { key: string }[]).map(r => r.key)
  } finally { d.close() }
}

test('decisions', () => {
  const m = (gen: number) => ({ gen, host: 'x', pushedAt: '', heartbeatAt: '' })
  assert.equal(shouldPull(null, 0), false, 'missing remote: nothing to pull')
  assert.equal(shouldPull(m(3), 3), false)
  assert.equal(shouldPull(m(4), 3), true)
  assert.equal(canPush(null, 0), true, 'first push seeds the folder')
  assert.equal(canPush(m(3), 3), true)
  assert.equal(canPush(m(4), 3), false, 'someone pushed since: refuse')
  const now = new Date('2026-10-03T12:00:00Z')
  const hb = (host: string, iso: string) => ({ gen: 1, host, pushedAt: iso, heartbeatAt: iso })
  assert.equal(otherActive(hb('mac', '2026-10-03T11:58:00Z'), 'pc', now), true)
  assert.equal(otherActive(hb('mac', '2026-10-03T11:50:00Z'), 'pc', now), false)
  assert.equal(otherActive(hb('pc', '2026-10-03T11:59:00Z'), 'pc', now), false)
})

test('round trip: A pushes, B pulls, B pushes, a stale A push is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobfinder-handoff-'))
  const sync = join(root, 'onedrive', 'job-finder-sync')
  const a = machine(root, 'a', sync)
  const b = machine(root, 'b', sync)

  insert(a.db, 'from-a')
  writeFileSync(join(a.cvDir, 'cv.pdf'), 'pdf')
  assert.throws(() => push(a, 'pc'), /sync folder missing/, 'missing folder: never seed a fork')
  assert.equal(pull(a).pulled, false)
  mkdirSync(sync, { recursive: true }) // created once by hand on the first machine
  assert.deepEqual(push(a, 'pc'), { ok: true, gen: 1 })
  assert.equal(readMeta(sync)?.gen, 1)

  insert(b.db, 'old-b') // B's own pre-sync history
  const r = pull(b)
  assert.equal(r.pulled, true)
  assert.deepEqual(keys(b.db), ['from-a'])
  assert.equal(readLocalGen(b.stateFile), 1)
  assert.equal(readFileSync(join(b.cvDir, 'cv.pdf'), 'utf8'), 'pdf')
  assert.ok(existsSync(b.backupsDir), 'pre-pull backup taken')

  insert(b.db, 'from-b')
  assert.deepEqual(push(b, 'mac'), { ok: true, gen: 2 })

  insert(a.db, 'stale-a') // A never pulled gen 2
  const stale = push(a, 'pc')
  assert.equal(stale.ok, false, 'stale push refused')
  assert.equal(readMeta(sync)?.gen, 2, 'remote untouched')
  assert.ok(readdirSync(a.backupsDir).some(f => f.startsWith('conflict-')), 'stale work kept')

  assert.equal(pull(a).pulled, true)
  assert.deepEqual(keys(a.db), ['from-a', 'from-b'])
})

test('corrupt snapshot: pull fails closed and keeps the local DB', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobfinder-handoff-'))
  const sync = join(root, 'sync')
  mkdirSync(sync)
  const b = machine(root, 'b', sync)
  insert(b.db, 'local')
  writeFileSync(join(sync, 'jobfinder.db'), 'not a database')
  writeFileSync(join(sync, 'sync.json'), JSON.stringify({ gen: 5, host: 'pc', pushedAt: '', heartbeatAt: '' }))
  const r = pull(b)
  assert.equal(r.pulled, false)
  assert.ok(r.error)
  assert.deepEqual(keys(b.db), ['local'])
  assert.equal(readLocalGen(b.stateFile), 0)
})

test('a OneDrive conflict copy stops both pull and push', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobfinder-handoff-'))
  const sync = join(root, 'sync')
  mkdirSync(sync)
  const a = machine(root, 'a', sync)
  insert(a.db, 'x')
  assert.deepEqual(push(a, 'pc'), { ok: true, gen: 1 })
  writeFileSync(join(sync, 'sync-Mac.json'), JSON.stringify({ gen: 1, host: 'mac', pushedAt: '', heartbeatAt: '' }))
  assert.deepEqual(strays(sync), ['sync-Mac.json'])
  assert.throws(() => push(a, 'pc'), /conflict copy.*sync-Mac\.json/)
  writeFileSync(join(sync, 'sync.json'), JSON.stringify({ gen: 2, host: 'mac', pushedAt: '', heartbeatAt: '' }))
  const r = pull(a)
  assert.equal(r.pulled, false)
  assert.match(r.error ?? '', /conflict copy/)
})

test('mirror copies new and changed files, never deletes', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobfinder-mirror-'))
  const from = join(root, 'from')
  const to = join(root, 'to')
  mkdirSync(join(from, 'tailored', 'x'), { recursive: true })
  mkdirSync(to)
  writeFileSync(join(from, 'tailored', 'x', 'cv.pdf'), 'a')
  writeFileSync(join(to, 'only-here.pdf'), 'keep')
  assert.equal(mirror(from, to), 1)
  assert.equal(mirror(from, to), 0, 'unchanged files are not recopied')
  assert.ok(existsSync(join(to, 'only-here.pdf')))
  assert.equal(readFileSync(join(to, 'tailored', 'x', 'cv.pdf'), 'utf8'), 'a')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.ts`
Expected: FAIL — `Cannot find module '../server/utils/handoff.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// server/utils/handoff.ts
// Hands the database between two machines that never run at once, through a cloud-synced folder.
// See docs/superpowers/specs/2026-10-03-cross-machine-sync-design.md.
//
// The live file never sits in the synced folder: a sync client copies the main file while commits
// still sit in -wal (the failure that cost the old file-copy backup 12 posts on 2026-09-25). Snapshots
// go through VACUUM INTO, and `gen` in sync.json makes every push a compare-and-swap, so a machine
// that booted before OneDrive delivered the newer snapshot can never overwrite it.
//
// No import of ./db: that module opens the database on import, and pull() must run before it does.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Copies files that are missing or differ in size/mtime. Never deletes: a mirror is not a sync. */
export function mirror(from: string, to: string): number {
  if (!existsSync(from)) return 0
  let copied = 0
  for (const name of readdirSync(from, { recursive: true }) as string[]) {
    const src = join(from, name)
    const st = statSync(src)
    if (!st.isFile()) continue
    const dst = join(to, name)
    const d = existsSync(dst) ? statSync(dst) : null
    if (d && d.size === st.size && d.mtimeMs >= st.mtimeMs) continue
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/handoff.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/handoff.ts test/handoff.test.ts
git commit -m "handoff: pull/push a VACUUM INTO snapshot through a synced folder, gen-guarded"
```

---

### Task 2: Wire it into the server — boot pull, 2-minute push, status + Sync now endpoints

**Files:**
- Create: `server/utils/handoff-runtime.ts`, `server/plugins/handoff.ts`, `server/api/sync.get.ts`, `server/api/sync/push.post.ts`
- Modify: `server/utils/db.ts` (call the boot pull at the top of `open()`), `.env.example`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `handoffState(): HandoffState` where `HandoffState = { enabled: boolean, host: string, gen: number, pushDisabled: string | null, conflict: SyncMeta | null, otherActive: boolean, lastPushAt: string | null, lastError: string | null, lastSig: string }`
  - `changeSig(): string` exported from `server/utils/db.ts`
  - `bootPull(): void` — no-op when disabled.
  - `pushNow(sig: string): HandoffState`
  - `GET /api/sync` → `HandoffState`; `POST /api/sync/push` → `HandoffState`

- [ ] **Step 0: Check no job is running**

Run: `curl -s http://127.0.0.1:3939/api/job`
Expected: every lane's `current` is `null` and `queue` is `[]`. If not, wait.

- [ ] **Step 1: Write `server/utils/handoff-runtime.ts`**

```ts
// The server's view of the hand-off: paths from the environment, and the one state object the plugin,
// the endpoints and the boot pull share. On globalThis for the same reason __jobfinderRunner is — HMR
// inside one Nitro worker re-evaluates modules.
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { heartbeat, otherActive, pull, push, readLocalGen, readMeta, type HandoffPaths, type SyncMeta } from './handoff.ts'

export interface HandoffState {
  enabled: boolean
  host: string
  gen: number
  pushDisabled: string | null
  conflict: SyncMeta | null
  otherActive: boolean
  lastPushAt: string | null
  lastError: string | null
  /** `data_version:total_changes` at the last push — see the plugin for why both. */
  lastSig: string
}

const g = globalThis as { __jobfinderHandoff?: HandoffState }

export function handoffPaths(): HandoffPaths | null {
  const dir = process.env.JOBFINDER_SYNC_DIR
  if (!dir) return null
  const cwd = process.cwd()
  return {
    db: resolve(cwd, process.env.JOBFINDER_DB || 'data/jobfinder.db'),
    cvDir: resolve(cwd, 'data/cv'),
    stateFile: resolve(cwd, 'data/sync-state.json'),
    backupsDir: resolve(cwd, 'backups'),
    syncDir: dir
  }
}

export function handoffState(): HandoffState {
  g.__jobfinderHandoff ??= {
    enabled: !!handoffPaths(), host: hostname(), gen: 0, pushDisabled: null, conflict: null,
    otherActive: false, lastPushAt: null, lastError: null, lastSig: ''
  }
  const s = g.__jobfinderHandoff
  const p = handoffPaths()
  if (p) {
    s.gen = readLocalGen(p.stateFile)
    s.otherActive = otherActive(readMeta(p.syncDir), s.host)
  }
  return s
}

/** Called from db.ts before the connection opens. */
export function bootPull() {
  const p = handoffPaths()
  if (!p) return
  const s = handoffState()
  const r = pull(p)
  if (r.error) {
    s.pushDisabled = `boot pull failed: ${r.error} — restart once OneDrive has finished syncing`
    console.error(`[sync] ${s.pushDisabled}`)
  } else if (r.pulled) {
    console.log(`[sync] pulled gen ${r.gen} from ${p.syncDir}`)
  }
  if (s.otherActive) console.warn('[sync] the other machine looks active — close it before working here')
}

export function pushNow(sig: string): HandoffState {
  const s = handoffState()
  const p = handoffPaths()
  if (!p || s.pushDisabled || s.conflict) return s
  try {
    const r = push(p, s.host)
    if (r.ok) {
      s.lastPushAt = new Date().toISOString()
      s.lastSig = sig
      s.lastError = null
    } else {
      s.conflict = r.conflict
      console.error(`[sync] ${r.conflict.host} pushed gen ${r.conflict.gen} since this machine pulled — not pushing; restart to pull it`)
    }
  } catch (e) {
    const msg = (e as Error).message
    // a forked folder is sticky (heartbeats stop too); a missing folder or an I/O error retries next tick
    if (msg.startsWith('conflict copy')) s.pushDisabled = msg
    else s.lastError = msg
    console.error(`[sync] ${msg}`)
  }
  return handoffState()
}

export function beat() {
  const p = handoffPaths()
  const s = handoffState()
  if (p && !s.pushDisabled && !s.conflict) {
    try { heartbeat(p, s.host) } catch (e) { s.lastError = (e as Error).message }
  }
}
```

- [ ] **Step 2: Call the boot pull in `server/utils/db.ts`**

At the top of `open()`, before `mkdirSync`:

```ts
import { bootPull } from './handoff-runtime'
// ...
function open() {
  bootPull() // a newer snapshot from the other machine replaces the file before anything opens it
  mkdirSync(dirname(DB_PATH), { recursive: true })
```

and, after `export { sqlite }`:

```ts
/**
 * Moves on any commit to the file. Both halves are needed: total_changes() counts this connection
 * only, and the job runners (scrape ingest, drafts, gaps, paste) write through their own
 * openWritableDb() connections — which data_version sees, because it moves on commits by OTHER
 * connections. Either alone misses a class of writes.
 */
export const changeSig = (): string =>
  `${sqlite.pragma('data_version', { simple: true })}:${(sqlite.prepare('SELECT total_changes() n').get() as { n: number }).n}`
```

- [ ] **Step 3: Write `server/plugins/handoff.ts`**

```ts
// Pushes a snapshot every 2 minutes when anything committed to the database (changeSig in db.ts).
// ponytail: whole-file snapshot (~8 MB); switch to session changesets if the DB passes ~100 MB.
import { changeSig } from '../utils/db'
import { beat, handoffState, pushNow } from '../utils/handoff-runtime'

const EVERY_MS = 2 * 60_000

export default defineNitroPlugin((nitro) => {
  if (!handoffState().enabled) return
  const timer = setInterval(() => {
    const sig = changeSig()
    if (sig !== handoffState().lastSig) pushNow(sig)
    else beat()
  }, EVERY_MS)
  nitro.hooks.hook('close', () => clearInterval(timer))
})
```

Note: `lastSig` starts empty, so the first tick after boot always pushes once — publishing this machine's gen and heartbeat. Intended.

Verify the job-runner half before trusting it: with sync on, run a paste (Posts view) or a short scrape, wait 2 minutes, and confirm `gen` in `sync.json` moved. That is the write path `total_changes()` alone missed.

- [ ] **Step 4: Write the endpoints**

```ts
// server/api/sync.get.ts
import { handoffState } from '../utils/handoff-runtime'
export default defineEventHandler(() => handoffState())
```

```ts
// server/api/sync/push.post.ts
import { changeSig } from '../../utils/db'
import { pushNow } from '../../utils/handoff-runtime'
export default defineEventHandler(() => pushNow(changeSig()))
```

- [ ] **Step 5: Document the variable in `.env.example`**

```
# JOBFINDER_SYNC_DIR=C:\Users\<you>\OneDrive\job-finder-sync   # hand the DB between two machines that never run at once
#   macOS: /Users/<you>/Library/CloudStorage/OneDrive-Personal/job-finder-sync — unset = sync off
```

- [ ] **Step 6: Verify (sync off, then on)**

1. Without the variable: `npm run dev`, `curl -s http://127.0.0.1:3939/api/sync` → `"enabled":false`. `npm test` passes.
2. Add `JOBFINDER_SYNC_DIR=C:\Users\Fast_\OneDrive\job-finder-sync` to `.env`, restart, then
   `curl -s -X POST http://127.0.0.1:3939/api/sync/push` → `"gen":1`, `"lastPushAt"` set; the folder holds `jobfinder.db`, `cv/`, `sync.json`.
3. `sqlite3 "C:/Users/Fast_/OneDrive/job-finder-sync/jobfinder.db" "select count(*) from posts"` equals the live count.
4. `npm run typecheck` and `npm run lint` pass.

- [ ] **Step 7: Commit**

```bash
git add server/utils/handoff-runtime.ts server/plugins/handoff.ts server/api/sync.get.ts server/api/sync/push.post.ts server/utils/db.ts .env.example
git commit -m "handoff: pull at boot, push every 2 minutes on change, /api/sync"
```

---

### Task 3: Tailored-CV paths that resolve on macOS

**Files:**
- Modify: `server/utils/cv-render.ts:134-135` (`tailoredCvPath`), `server/utils/cv-attach.ts:50-56` (`followUpAttachment`), `server/plugins/migrate.ts` (one idempotent UPDATE)
- Test: `test/cv-persist.test.ts` (append) — or `test/handoff.test.ts` if `cv-persist` imports something heavy

**Interfaces:**
- Produces: `tailoredCvPath()` returns a `/`-separated repo-relative path; `followUpAttachment(stored, cvPath, exists)` accepts `\` in `stored`.

- [ ] **Step 1: Write the failing test**

```ts
import { followUpAttachment } from '../server/utils/cv-attach.ts'
import { tailoredCvPath } from '../server/utils/cv-render.ts'

test('tailored CV paths are stored with / and old backslash rows still resolve', () => {
  assert.equal(tailoredCvPath('data/cv/CV.pdf', 'a.b@x.com').includes('\\'), false)
  const seen: string[] = []
  const got = followUpAttachment('data\\cv\\tailored\\x\\CV.pdf', 'data/cv/CV.pdf', (p) => { seen.push(p); return true })
  assert.equal(got, 'data/cv/tailored/x/CV.pdf')
  assert.deepEqual(seen, ['data/cv/tailored/x/CV.pdf'])
})
```

- [ ] **Step 2: Run it — expect FAIL** (`includes('\\')` true on Windows; `got` keeps backslashes)

Run: `node --test test/cv-persist.test.ts`

- [ ] **Step 3: Implement**

`server/utils/cv-render.ts` — import `posix` from `node:path` and use it in `tailoredCvPath` (Node on Windows accepts `/`, macOS does not accept `\`):

```ts
export const tailoredCvPath = (cvPath: string, recruiterEmail: string): string =>
  posix.join('data', 'cv', 'tailored', folderFor(recruiterEmail), basename(cvPath))
```

(`basename` stays the platform one — the uploaded path may carry either separator on Windows.)

`server/utils/cv-attach.ts`:

```ts
export function followUpAttachment(
  stored: string | null,
  cvPath: string,
  exists: (path: string) => boolean = existsSync
): string {
  // rows written on Windows before 2026-10-03 carry `\`, which macOS reads as part of a file name
  const path = stored?.replaceAll('\\', '/')
  return path && exists(path) ? path : cvPath
}
```

`server/plugins/migrate.ts` — after `migrateDb()` succeeds, before `importLegacyConfig()`:

```ts
  // Windows wrote tailored-CV paths with `\`; macOS cannot open them. Idempotent, so it runs every boot.
  const fixed = sqlite.prepare(String.raw`UPDATE contacts SET cv_path = replace(cv_path, '\', '/') WHERE cv_path LIKE '%\%'`).run().changes
  if (fixed) console.log(`[db] normalised ${fixed} tailored-CV path(s) to /`)
```

Verify the bytes after editing (memory: escape sequences get mangled): `grep -n "replace(cv_path" server/plugins/migrate.ts` must show a single backslash inside `'\'` and `'%\%'`.

- [ ] **Step 4: Run the test and the suite — expect PASS**

Run: `node --test test/cv-persist.test.ts && npm test`

- [ ] **Step 5: Verify on the live DB after a restart (job lanes idle first)**

Run: `sqlite3 data/jobfinder.db "select count(*) from contacts where cv_path like '%\%'"` → `0`.

- [ ] **Step 6: Commit**

```bash
git add server/utils/cv-render.ts server/utils/cv-attach.ts server/plugins/migrate.ts test/cv-persist.test.ts
git commit -m "Tailored-CV paths use / so a follow-up drafted on macOS attaches the right CV"
```

---

### Task 4: Run view — Sync line and Sync now

**Files:**
- Modify: `app/pages/run.vue` (script: one `useFetch`; template: one `UCard` before the Yield card, around line 267)
- Modify: `app/types/index.d.ts` (add `SyncState`)

- [ ] **Step 1: Add the type** to `app/types/index.d.ts`:

```ts
export interface SyncState {
  enabled: boolean
  host: string
  gen: number
  pushDisabled: string | null
  conflict: { gen: number, host: string } | null
  otherActive: boolean
  lastPushAt: string | null
  lastError: string | null
}
```

- [ ] **Step 2: Script** in `run.vue`, after the `yields` fetch:

```ts
const { data: syncState, refresh: refreshSync } = await useFetch<SyncState>('/api/sync', { lazy: true })
async function syncNow() {
  syncState.value = await $fetch<SyncState>('/api/sync/push', { method: 'POST' })
  toast.add({ title: syncState.value.conflict ? 'Not pushed — another machine pushed first' : `Synced (gen ${syncState.value.gen})` })
}
```

and add `SyncState` to the `~/types` import. Refresh it when a job finishes, not on every poll tick: `watch(running, r => { if (!r) refreshSync() })`.

- [ ] **Step 3: Template** — before the Yield `UCard`:

```vue
      <UCard
        v-if="syncState?.enabled"
        class="shrink-0"
      >
        <div class="flex items-center gap-3 text-sm">
          <span class="font-semibold text-highlighted">Sync</span>
          <span class="text-muted mr-auto">
            {{ syncState.host }} · gen {{ syncState.gen }} · last push {{ syncState.lastPushAt ? new Date(syncState.lastPushAt).toLocaleTimeString() : 'not yet' }}
          </span>
          <UButton
            size="sm"
            variant="soft"
            icon="i-lucide-refresh-cw"
            :disabled="!!syncState.conflict || !!syncState.pushDisabled"
            @click="syncNow"
          >
            Sync now
          </UButton>
        </div>
        <UAlert
          v-if="syncState.conflict"
          class="mt-3"
          color="error"
          :title="`${syncState.conflict.host} pushed gen ${syncState.conflict.gen} after this machine started. Restart to pull it — work done here since is in backups/conflict-*.db.`"
        />
        <UAlert
          v-else-if="syncState.pushDisabled"
          class="mt-3"
          color="warning"
          :title="syncState.pushDisabled"
        />
        <UAlert
          v-else-if="syncState.otherActive"
          class="mt-3"
          color="warning"
          title="The other machine looks active. Close it before working here."
        />
        <p
          v-if="syncState.lastError"
          class="mt-2 text-xs text-error"
        >
          {{ syncState.lastError }}
        </p>
      </UCard>
```

- [ ] **Step 4: Verify**

`npm run typecheck && npm run lint`, then `node scripts/screenshot.mjs` and look at the Run screenshot: the Sync card shows host, gen and last push.

- [ ] **Step 5: Commit**

```bash
git add app/pages/run.vue app/types/index.d.ts
git commit -m "Run view: sync status and Sync now"
```

---

### Task 5: One-time merge of the Mac's existing history

The Mac already holds its own separate database. Its first boot with sync on replaces it (the pre-pull backup keeps it). This task merges that backup into the shared history once.

**Files:**
- Create: `scripts/merge-db.ts`
- Test: `test/merge-db.test.ts`

**Interfaces:**
- Produces: `mergeInto(target: Database.Database, sourceFile: string): Record<string, number>` (rows inserted per table)

Rules — insert-only, never overwrite the target's rows:
- `posts`, `post_requirements`, `requirement_runs`: `INSERT OR IGNORE` by primary key.
- `applications`: `INSERT OR IGNORE` by key (an existing target verdict wins; the Gmail gate re-checks before any draft anyway).
- `contacts`: `INSERT OR IGNORE` by email, then run a Gmail sweep — Gmail is the truth for stages and the sweep heals the cache.
- `settings`: never merged (target wins).

- [ ] **Step 1: Write the failing test**

```ts
// test/merge-db.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { mergeInto } from '../scripts/merge-db.ts'

const DDL = `
  CREATE TABLE posts (key TEXT PRIMARY KEY, text TEXT);
  CREATE TABLE applications (key TEXT PRIMARY KEY, verdict TEXT);
  CREATE TABLE contacts (email TEXT PRIMARY KEY, stage TEXT);
  CREATE TABLE post_requirements (id INTEGER PRIMARY KEY, key TEXT, term TEXT);
  CREATE TABLE requirement_runs (key TEXT PRIMARY KEY, cv_sha TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY, json TEXT);`

test('merge inserts what the target lacks and never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-merge-'))
  const src = new Database(join(dir, 'mac.db'))
  src.exec(DDL)
  src.exec(`INSERT INTO posts VALUES ('k1','mac'),('k2','mac');
            INSERT INTO applications VALUES ('k1','skipped');
            INSERT INTO contacts VALUES ('r@x.com','contacted');
            INSERT INTO settings VALUES (1,'{"mac":true}')`)
  src.close()
  const tgt = new Database(join(dir, 'pc.db'))
  tgt.exec(DDL)
  tgt.exec(`INSERT INTO posts VALUES ('k1','pc'); INSERT INTO applications VALUES ('k1','drafted');
            INSERT INTO settings VALUES (1,'{"pc":true}')`)

  const n = mergeInto(tgt, join(dir, 'mac.db'))
  assert.equal(n.posts, 1)
  assert.equal((tgt.prepare(`SELECT text FROM posts WHERE key='k1'`).get() as { text: string }).text, 'pc')
  assert.equal((tgt.prepare(`SELECT verdict FROM applications WHERE key='k1'`).get() as { verdict: string }).verdict, 'drafted')
  assert.equal(n.contacts, 1)
  assert.equal((tgt.prepare('SELECT json FROM settings').get() as { json: string }).json, '{"pc":true}')
})
```

Before writing the implementation, check the real primary keys: `sqlite3 data/jobfinder.db ".schema post_requirements" ".schema requirement_runs"`. If `post_requirements.id` is an autoincrement surrogate, merge it on its natural columns instead (`INSERT ... SELECT key, term, ... WHERE NOT EXISTS (same key and lower(term))`) — a surrogate id collision would silently drop Mac rows. Adjust the test's DDL to match.

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../scripts/merge-db.ts'`)

Run: `node --test test/merge-db.test.ts`

- [ ] **Step 3: Implement `scripts/merge-db.ts`**

```ts
// One-time merge of a second machine's separate history into this database. Insert-only: the target's
// rows always win, settings are never merged, and contacts stages are healed afterwards by a Gmail
// sweep (Gmail is the truth; contacts only caches it).
// Usage (server STOPPED — it is the sole writer): node scripts/merge-db.ts <source.db> [target.db]
import Database from 'better-sqlite3'

const TABLES = ['posts', 'applications', 'contacts', 'post_requirements', 'requirement_runs'] as const

export function mergeInto(target: Database.Database, sourceFile: string): Record<string, number> {
  target.prepare('ATTACH DATABASE ? AS src').run(sourceFile)
  try {
    const out: Record<string, number> = {}
    target.transaction(() => {
      for (const t of TABLES) {
        const cols = (target.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map(c => c.name)
        const srcCols = new Set((target.prepare(`SELECT name FROM pragma_table_info('${t}', 'src')`).all() as { name: string }[]).map(c => c.name))
        const shared = cols.filter(c => srcCols.has(c)).map(c => `"${c}"`).join(', ')
        out[t] = target.prepare(`INSERT OR IGNORE INTO main."${t}" (${shared}) SELECT ${shared} FROM src."${t}"`).run().changes
      }
    })()
    return out
  } finally {
    target.exec('DETACH DATABASE src')
  }
}

if (process.argv[1]?.endsWith('merge-db.ts')) { // run directly, not imported by the test
  const [source, targetFile = 'data/jobfinder.db'] = process.argv.slice(2)
  if (!source) {
    console.error('usage: node scripts/merge-db.ts <source.db> [target.db]')
    process.exit(1)
  }
  const db = new Database(targetFile)
  console.log(mergeInto(db, source))
  db.close()
}
```

(`pragma_table_info(t, 'src')` — schema as the last argument, the documented form — handles a source one migration behind: only shared columns are copied. Adjust per the Step 1 schema check if `post_requirements` needs natural-key dedupe.)

- [ ] **Step 4: Run test — expect PASS**

Run: `node --test test/merge-db.test.ts && npm test`

- [ ] **Step 5: Commit**

```bash
git add scripts/merge-db.ts test/merge-db.test.ts
git commit -m "scripts/merge-db.ts: one-time insert-only merge of a second machine's history"
```

---

### Task 6: Docs and the real Windows ↔ Mac round trip

**Files:**
- Modify: `SETUP.md` (new section "Two machines"), `CLAUDE.md` (Configuration: `JOBFINDER_SYNC_DIR`; a Gotchas entry; Never commit: `data/sync-state.json` is already under `data/`)

- [ ] **Step 1: `SETUP.md` — "Two machines"** covering, in order:
  1. Both machines must never run `npm run dev` at the same time — sync is a hand-off, not a live share.
  2. Create the folder once on Windows (`mkdir C:\Users\<you>\OneDrive\job-finder-sync`) and set `JOBFINDER_SYNC_DIR` in `.env` on both machines. On the Mac, start the app only after Finder shows that folder **and its `sync.json`** — a push refuses while the folder is missing, but a folder delivered without its files would look like a fresh start.
  3. Copy `.env`, `google-oauth.json`, `gmail-token.json` by hand once (USB / password manager — not OneDrive).
  4. On the Mac: `npm install` under the Volta-pinned Node, then `npm run login`.
  5. First Mac boot pulls the shared DB; its old DB lands in `backups/pre-pull-*.db`. Merge it once with the server stopped: `node scripts/merge-db.ts backups/pre-pull-<stamp>.db`, start the server, Pipeline → run a sweep.
  6. Before closing a machine: Run view → **Sync now**, then **wait for OneDrive's synced checkmark on the folder** before closing the lid (the 2-minute push covers a forgotten button, not an unfinished upload). If the upload had not finished and both machines pushed, OneDrive leaves a conflict copy (`sync-<machine>.json`); both machines then refuse to sync and name the file. Fix: merge the other DB with `scripts/merge-db.ts`, delete the stray, restart.
  7. The OneDrive copy holds recruiter names/addresses and the CV.

- [ ] **Step 2: `CLAUDE.md`** — add `JOBFINDER_SYNC_DIR` to the `.env` bullet, and under Gotchas → The server and the UI:

  > **Two machines hand off, never share.** `server/utils/handoff.ts` pulls a newer `VACUUM INTO` snapshot at boot — inside `db.ts`'s `open()`, before any connection — and pushes one every 2 minutes when `total_changes()` moved. `gen` in `sync.json` makes each push a compare-and-swap: a machine that booted before OneDrive delivered the newer snapshot is refused and shows a banner instead of overwriting it. Never move `data/` itself into OneDrive — a file sync of a WAL database is the 2026-09-25 backup bug. Paths written to the DB use `/` (`tailoredCvPath` is `posix.join`), because the other machine is a Mac.

- [ ] **Step 3: Real round trip** (job lanes idle on both sides)
  1. Windows: Sync now → note `gen` and `select count(*) from posts`.
  2. Close Windows' dev server. Wait for OneDrive to show the folder synced on the Mac.
  3. Mac: `npm run dev` → log shows `[sync] pulled gen N`; post count matches; `curl -s http://127.0.0.1:3939/api/sync` shows the same gen.
  4. Mac: merge its old DB (SETUP step 5), dismiss one post, Sync now → gen N+1.
  5. Windows: start → `[sync] pulled gen N+1`; the dismissed post is dismissed.
  6. Negative check (Mac closed): on Windows, edit `sync.json` `gen` to N+5, press Sync now → conflict banner, a new `backups/conflict-*.db`, `sync.json` still N+5. Then set `gen` back to N+1 and restart — no pull (equal gen), pushing resumes.

- [ ] **Step 4: Commit**

```bash
git add SETUP.md CLAUDE.md
git commit -m "Docs: two-machine hand-off setup and the never-concurrent rule"
```
