// Two temp dirs stand in for two machines sharing one OneDrive folder. Both may run, but only one leads,
// which is why a whole-file hand-off is still enough.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { bootRole, canPush, heartbeat, livePeer, livePull, mirror, nextStep, otherActive, pull, push, readLocalGen, readMeta, shouldPull, standbyRefuses, strays, type HandoffPaths, type Me, type Peer } from '../server/utils/handoff.ts'

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

test('the boot pull runs once per process, never again on a dev worker rebuild', async () => {
  const { firstBootInProcess } = await import('../server/utils/handoff-runtime.ts')
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-boot-'))
  const marker = join(dir, 'boot-pid')
  assert.equal(firstBootInProcess(marker, 100), true)
  assert.equal(firstBootInProcess(marker, 100), false, 'same process: a rebuilt worker')
  assert.equal(firstBootInProcess(marker, 200), true, 'a real restart')
})

// ---- the lease: both machines running, one leading (docs/superpowers/specs/2026-10-24-live-standby-design.md)

const T = new Date('2026-10-24T12:00:00Z')
const me = (o: Partial<Me> = {}): Me => ({ host: 'mac', role: 'active', since: '2026-10-24T09:00:00.000Z', busy: false, localGen: 4, remoteGen: 4, ...o })
const peer = (o: Partial<Peer> = {}): Peer => ({ host: 'pc', at: T.toISOString(), role: 'standby', since: '', gen: 4, ...o })

test('nextStep: the leader yields to a claim, to a later leader, and to a newer gen — never pulls under its jobs', () => {
  assert.deepEqual(nextStep(me(), peer(), T), { role: 'active' })
  assert.deepEqual(nextStep(me(), null, T), { role: 'active' })
  assert.deepEqual(nextStep(me(), peer({ role: 'claiming' }), T), { role: 'yielding', stop: true })
  assert.deepEqual(nextStep(me(), peer({ role: 'active', since: '2026-10-24T11:00:00.000Z' }), T), { role: 'yielding', stop: true }, 'woke up after a take-over')
  assert.deepEqual(nextStep(me(), peer({ role: 'active', since: '2026-10-24T08:00:00.000Z' }), T), { role: 'active' }, 'the older leader is the one that yields')
  assert.deepEqual(nextStep(me(), peer({ role: 'active', since: me().since }), T), { role: 'active' }, 'tie: the lower host name keeps it')
  assert.deepEqual(nextStep(me({ host: 'pc' }), peer({ host: 'mac', role: 'active', since: me().since }), T), { role: 'yielding', stop: true })
  assert.deepEqual(nextStep(me({ remoteGen: 5 }), null, T), { role: 'yielding', stop: true }, 'someone published over us')
})

test('nextStep: yielding waits for its jobs, then pushes and stands by', () => {
  assert.deepEqual(nextStep(me({ role: 'yielding', busy: true }), peer({ role: 'claiming' }), T), { role: 'yielding' })
  assert.deepEqual(nextStep(me({ role: 'yielding' }), peer({ role: 'claiming' }), T), { role: 'standby', finish: true })
})

test('nextStep: standby follows the leader, and leads once nobody does', () => {
  assert.deepEqual(nextStep(me({ role: 'standby' }), peer({ role: 'active' }), T), { role: 'standby' })
  assert.deepEqual(nextStep(me({ role: 'standby', remoteGen: 6 }), peer({ role: 'active' }), T), { role: 'standby', pull: true })
  assert.deepEqual(nextStep(me({ role: 'standby', remoteGen: 6 }), null, T), { role: 'standby', pull: true }, 'no visible peer: closed, or our own OneDrive is offline — wait for the button')
  assert.deepEqual(nextStep(me({ role: 'standby' }), peer(), T), { role: 'active', since: T.toISOString() }, 'both standby: the lower host name leads')
  assert.deepEqual(nextStep(me({ role: 'standby', host: 'pc' }), peer({ host: 'mac' }), T), { role: 'standby' }, '…and the higher one waits')
})

test('nextStep: claiming waits for the leader to stand down and for its last snapshot', () => {
  const c = me({ role: 'claiming', localGen: 4, remoteGen: 4 })
  assert.deepEqual(nextStep(c, peer({ role: 'active' }), T), { role: 'claiming' })
  assert.deepEqual(nextStep(c, peer({ role: 'yielding' }), T), { role: 'claiming' })
  assert.deepEqual(nextStep(c, peer({ role: 'standby', gen: 5 }), T), { role: 'claiming' }, 'its gen-5 sync.json has not arrived yet')
  assert.deepEqual(nextStep({ ...c, remoteGen: 5 }, peer({ role: 'standby', gen: 5 }), T), { role: 'active', since: T.toISOString(), pull: true })
  assert.deepEqual(nextStep(c, peer({ role: 'standby', gen: 4 }), T), { role: 'active', since: T.toISOString() }, 'nothing left to push')
  assert.deepEqual(nextStep(c, null, T), { role: 'active', since: T.toISOString() }, 'stale heartbeat: take over')
  assert.deepEqual(nextStep(c, peer({ role: 'claiming' }), T), { role: 'claiming' })
  assert.deepEqual(nextStep({ ...c, host: 'pc' }, peer({ host: 'mac', role: 'claiming' }), T), { role: 'standby' }, 'both pressed: the higher host name backs off')
})

test('bootRole and livePeer: a fresh process stands by while the other leads; an old heartbeat reads as leading', () => {
  const { sync, a } = setup()
  mkdirSync(sync, { recursive: true })
  assert.equal(bootRole(null), 'active')
  assert.equal(bootRole(peer({ role: 'standby' })), 'active')
  for (const r of ['active', 'claiming', 'yielding'] as const) assert.equal(bootRole(peer({ role: r })), 'standby')
  writeFileSync(join(sync, 'heartbeat-pc.json'), JSON.stringify({ at: '2026-10-24T11:59:00Z' })) // a build from before the lease
  assert.deepEqual(livePeer(sync, 'mac', T), { host: 'pc', at: '2026-10-24T11:59:00Z', role: 'active', since: '', gen: 0 })
  heartbeat(a, 'mac', T, { role: 'standby', since: 's', gen: 3 })
  assert.equal(livePeer(sync, 'pc', T)?.role, 'standby')
  assert.equal(livePeer(sync, 'pc', new Date('2026-10-24T12:06:00Z')), null, 'stale')
})

test('standbyRefuses: every API write but the hand-off controls', () => {
  assert.equal(standbyRefuses('active', 'POST', '/api/run/draft'), false)
  assert.equal(standbyRefuses('standby', 'POST', '/api/run/draft'), true)
  assert.equal(standbyRefuses('claiming', 'PUT', '/api/config'), true)
  assert.equal(standbyRefuses('standby', 'GET', '/api/posts?x=1'), false)
  assert.equal(standbyRefuses('standby', 'POST', '/api/sync/claim'), false)
  assert.equal(standbyRefuses('standby', 'POST', '/_nuxt/x'), false)
})

function schema(file: string) {
  const d = new Database(file)
  d.pragma('journal_mode = WAL')
  d.pragma('foreign_keys = ON')
  d.exec(`CREATE TABLE IF NOT EXISTS posts (key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS applications (key TEXT PRIMARY KEY REFERENCES posts(key) ON DELETE CASCADE, verdict TEXT);
    CREATE TABLE IF NOT EXISTS job_queue (id INTEGER PRIMARY KEY, kind TEXT)`)
  return d
}

test('live take-over: B claims, A stands down and pushes, B pulls into its open connection; job_queue stays B\'s', () => {
  const { sync, a, b } = setup()
  mkdirSync(sync, { recursive: true })
  const da = schema(a.db)
  da.exec(`INSERT INTO posts VALUES ('p1'); INSERT INTO applications VALUES ('p1', 'drafted'); INSERT INTO job_queue VALUES (1, 'draft-from-a')`)
  da.close()
  push(a, 'pc', T, { init: true })
  pull(b) // B boots, takes gen 1, and stands by while A leads
  const live = schema(b.db) // B's server connection: stays open throughout
  live.exec(`DELETE FROM job_queue; INSERT INTO job_queue VALUES (7, 'b-own')`)

  // A works on, then sees B's claim, stops its jobs and pushes its last changes
  const da2 = new Database(a.db)
  da2.exec(`INSERT INTO posts VALUES ('p2'); INSERT INTO applications VALUES ('p2', 'drafted')`)
  da2.close()
  assert.equal(nextStep(me({ host: 'pc', localGen: 1, remoteGen: 1 }), peer({ host: 'mac', role: 'claiming', gen: 1 }), T).role, 'yielding')
  assert.deepEqual(push(a, 'pc', T), { ok: true, gen: 2 })
  heartbeat(a, 'pc', T, { role: 'standby', since: '', gen: 2 })

  const step = nextStep(me({ role: 'claiming', localGen: readLocalGen(b.stateFile), remoteGen: readMeta(sync)!.gen }), livePeer(sync, 'mac', T), T)
  assert.deepEqual(step, { role: 'active', since: T.toISOString(), pull: true })
  assert.deepEqual(livePull(live, b), { pulled: true, gen: 2 })
  assert.deepEqual(live.prepare('SELECT key, verdict FROM applications ORDER BY key').all(), [{ key: 'p1', verdict: 'drafted' }, { key: 'p2', verdict: 'drafted' }])
  assert.deepEqual(live.prepare('SELECT id, kind FROM job_queue').all(), [{ id: 7, kind: 'b-own' }], 'never the other machine\'s queue')
  assert.equal(readLocalGen(b.stateFile), 2)
  assert.deepEqual(livePull(live, b), { pulled: false, gen: 2 }, 'nothing newer')
  live.close()
})

test('livePull refuses a snapshot that has not fully arrived, and leaves the live rows alone', () => {
  const { sync, a, b } = setup()
  mkdirSync(sync, { recursive: true })
  schema(a.db).close()
  insert(a.db, 'gen1')
  push(a, 'pc', T, { init: true })
  const gen1 = readFileSync(join(sync, 'jobfinder.db'))
  insert(a.db, 'gen2')
  push(a, 'pc', T)
  writeFileSync(join(sync, 'jobfinder.db'), gen1)
  const live = schema(b.db)
  live.exec(`INSERT INTO posts VALUES ('local')`)
  const r = livePull(live, b)
  assert.equal(r.pulled, false)
  assert.match(r.error ?? '', /not yet downloaded/)
  assert.deepEqual(live.prepare('SELECT key FROM posts').all(), [{ key: 'local' }])
  live.close()
})
