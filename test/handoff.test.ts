// Two temp dirs stand in for two machines sharing one OneDrive folder. The machines never run at once,
// which is the only reason a whole-file hand-off is enough.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { canPush, heartbeat, mirror, otherActive, pull, push, readLocalGen, readMeta, shouldPull, strays, type HandoffPaths } from '../server/utils/handoff.ts'

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
  } finally {
    d.close()
  }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'jobfinder-handoff-'))
  const sync = join(root, 'onedrive', 'job-finder-sync')
  return { root, sync, a: machine(root, 'a', sync), b: machine(root, 'b', sync) }
}
const backups = (p: HandoffPaths, prefix: string) =>
  existsSync(p.backupsDir) ? readdirSync(p.backupsDir).filter(f => f.startsWith(prefix)) : []

test('decisions', () => {
  const m = (gen: number) => ({ gen, host: 'x', pushedAt: '', sha256: '', size: 0 })
  assert.equal(shouldPull(null, 0), false, 'missing remote: nothing to pull')
  assert.equal(shouldPull(m(3), 3), false)
  assert.equal(shouldPull(m(4), 3), true)
  assert.equal(canPush(null, 0), true)
  assert.equal(canPush(m(3), 3), true)
  assert.equal(canPush(m(4), 3), false, 'someone pushed since: refuse')
})

test('round trip: A seeds, B pulls, B pushes, a stale A push is refused', () => {
  const { sync, a, b } = setup()
  insert(a.db, 'from-a')
  writeFileSync(join(a.cvDir, 'cv.pdf'), 'pdf')
  assert.throws(() => push(a, 'pc', new Date(), { init: true }), /sync folder missing/, 'missing folder: never seed a fork')
  assert.equal(pull(a).pulled, false)
  mkdirSync(sync, { recursive: true }) // created once by hand on the first machine
  assert.deepEqual(push(a, 'pc', new Date(), { init: true }), { ok: true, gen: 1 })
  assert.equal(readMeta(sync)?.gen, 1)

  insert(b.db, 'old-b') // B's own pre-sync history
  const r = pull(b)
  assert.equal(r.pulled, true)
  assert.deepEqual(keys(b.db), ['from-a'])
  assert.equal(readLocalGen(b.stateFile), 1)
  assert.equal(readFileSync(join(b.cvDir, 'cv.pdf'), 'utf8'), 'pdf')
  assert.equal(backups(b, 'pre-sync-').length, 1, 'the first pull keeps the pre-sync history')

  insert(b.db, 'from-b')
  assert.deepEqual(push(b, 'mac'), { ok: true, gen: 2 })

  insert(a.db, 'stale-a') // A never pulled gen 2
  const stale = push(a, 'pc')
  assert.equal(stale.ok, false, 'stale push refused')
  assert.equal(readMeta(sync)?.gen, 2, 'remote untouched')
  assert.equal(backups(a, 'conflict-').length, 1, 'stale work kept')

  assert.equal(pull(a).pulled, true)
  assert.deepEqual(keys(a.db), ['from-a', 'from-b'])
  assert.equal(backups(a, 'pre-pull-').length, 1)
})

test('seeding an empty folder is explicit: a machine that sees no sync.json does not publish on its own', () => {
  const { sync, a } = setup()
  mkdirSync(sync, { recursive: true }) // OneDrive created the folder but has not delivered sync.json yet
  insert(a.db, 'old-history')
  assert.throws(() => push(a, 'mac'), /init/)
  assert.equal(readMeta(sync), null)
})

test('sync.json unreadable after a history exists: retry, never a conflict backup', () => {
  const { sync, a } = setup()
  mkdirSync(sync, { recursive: true })
  insert(a.db, 'x')
  push(a, 'pc', new Date(), { init: true })
  rmSync(join(sync, 'sync.json'))
  assert.throws(() => push(a, 'pc'), /sync\.json unreadable/)
  assert.equal(backups(a, 'conflict-').length, 0)
})

test('a snapshot older than its sync.json (OneDrive delivered the small file first) is not pulled', () => {
  const { sync, a, b } = setup()
  mkdirSync(sync, { recursive: true })
  insert(a.db, 'gen1')
  push(a, 'pc', new Date(), { init: true })
  const gen1 = readFileSync(join(sync, 'jobfinder.db'))
  insert(a.db, 'gen2')
  push(a, 'pc')
  writeFileSync(join(sync, 'jobfinder.db'), gen1) // the gen-2 sync.json arrived, the gen-2 snapshot has not

  insert(b.db, 'local')
  const r = pull(b)
  assert.equal(r.pulled, false)
  assert.match(r.error ?? '', /not yet downloaded/)
  assert.deepEqual(keys(b.db), ['local'])
  assert.equal(readLocalGen(b.stateFile), 0)
})

test('corrupt snapshot: pull fails closed and keeps the local DB', () => {
  const { sync, b } = setup()
  mkdirSync(sync, { recursive: true })
  insert(b.db, 'local')
  writeFileSync(join(sync, 'jobfinder.db'), 'not a database')
  writeFileSync(join(sync, 'sync.json'), JSON.stringify({ gen: 5, host: 'pc', pushedAt: '', sha256: 'x', size: 14 }))
  const r = pull(b)
  assert.equal(r.pulled, false)
  assert.ok(r.error)
  assert.deepEqual(keys(b.db), ['local'])
  assert.equal(readLocalGen(b.stateFile), 0)
})

test('a failed CV mirror after the swap still records the pulled gen', () => {
  const { sync, a, b } = setup()
  mkdirSync(sync, { recursive: true })
  insert(a.db, 'x')
  push(a, 'pc', new Date(), { init: true })
  rmSync(join(sync, 'cv'), { recursive: true, force: true })
  writeFileSync(join(sync, 'cv'), 'a file where the folder should be') // readdir throws ENOTDIR
  const r = pull(b)
  assert.equal(r.pulled, true)
  assert.ok(r.warning)
  assert.equal(readLocalGen(b.stateFile), 1, 'the next boot must not pull over this session')
})

test('a OneDrive conflict copy stops both pull and push; OS metadata does not', () => {
  const { sync, a } = setup()
  mkdirSync(sync, { recursive: true })
  insert(a.db, 'x')
  push(a, 'pc', new Date(), { init: true })
  for (const f of ['.DS_Store', 'desktop.ini', 'heartbeat-mac.json']) writeFileSync(join(sync, f), '')
  assert.deepEqual(strays(sync), [])
  assert.deepEqual(push(a, 'pc'), { ok: true, gen: 2 }, 'metadata files are not conflicts')

  writeFileSync(join(sync, 'sync-Mac.json'), '{}')
  writeFileSync(join(sync, 'jobfinder-Mac.db'), '')
  assert.deepEqual(strays(sync).sort(), ['jobfinder-Mac.db', 'sync-Mac.json'])
  assert.throws(() => push(a, 'pc'), /conflict copy/)
  writeFileSync(join(sync, 'sync.json'), JSON.stringify({ gen: 3, host: 'mac', pushedAt: '', sha256: '', size: 0 }))
  const r = pull(a)
  assert.equal(r.pulled, false)
  assert.match(r.error ?? '', /conflict copy/)
})

test('heartbeats go to a per-host file and never touch sync.json', () => {
  const { sync, a } = setup()
  mkdirSync(sync, { recursive: true })
  insert(a.db, 'x')
  push(a, 'pc', new Date(), { init: true })
  const before = readFileSync(join(sync, 'sync.json'), 'utf8')
  const now = new Date('2026-10-03T12:00:00Z')
  heartbeat(a, 'mac', new Date('2026-10-03T11:58:00Z'))
  assert.equal(readFileSync(join(sync, 'sync.json'), 'utf8'), before)
  assert.equal(otherActive(sync, 'pc', now), true)
  assert.equal(otherActive(sync, 'mac', now), false, 'its own heartbeat is not another machine')
  assert.equal(otherActive(sync, 'pc', new Date('2026-10-03T12:10:00Z')), false, 'stale heartbeat')
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
