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
  } finally {
    d.close()
  }
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
  assert.ok(readdirSync(b.backupsDir).some(f => f.startsWith('pre-pull-')), 'pre-pull backup taken')

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
