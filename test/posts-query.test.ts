// The SQL text builders behind /api/posts, run against a real SQLite so the ORDER BY and WHERE are
// tested by what the database does with them, not by how the strings look.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { countryClause, orderSql } from '../server/utils/posts-query.ts'
import { NO_COUNTRY } from '../shared/countries.ts'

// A minimal posts table: only the columns the ORDER BY reads.
function seed() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE posts (key TEXT PRIMARY KEY, score INTEGER, title TEXT, posted_at INTEGER,
    scraped_at INTEGER, flags TEXT NOT NULL DEFAULT '[]')`)
  const ins = db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?)')
  ins.run('a', 8, 'Backend', 300, 10, '[]')
  ins.run('b', 6, null, null, 30, '[]')
  ins.run('c', 9, 'Architect', 100, 20, '["junior"]') // flagged
  ins.run('d', 7, 'devops', 200, 40, '[]')
  return db
}
const keys = (db: Database.Database, order: string) =>
  (db.prepare(`SELECT key FROM posts ORDER BY ${order}`).all() as { key: string }[]).map(r => r.key)

test('default keeps the pre-grid order: flagged last, then score desc', () => {
  assert.deepEqual(keys(seed(), orderSql('default', 'desc')), ['a', 'd', 'b', 'c'])
})

test('flagged rows stay last under every explicit sort', () => {
  for (const s of ['score', 'title', 'posted', 'added'] as const) {
    for (const d of ['asc', 'desc'] as const) assert.equal(keys(seed(), orderSql(s, d)).at(-1), 'c', `${s} ${d}`)
  }
})

test('NULLs sort last in both directions', () => {
  assert.deepEqual(keys(seed(), orderSql('posted', 'desc')), ['a', 'd', 'b', 'c'])
  assert.deepEqual(keys(seed(), orderSql('posted', 'asc')), ['d', 'a', 'b', 'c'])
  assert.deepEqual(keys(seed(), orderSql('title', 'asc')), ['a', 'd', 'b', 'c']) // case-folded: Backend < devops
  assert.deepEqual(keys(seed(), orderSql('title', 'desc')), ['d', 'a', 'b', 'c'])
})

test('added sorts by scraped_at', () => {
  assert.deepEqual(keys(seed(), orderSql('added', 'desc')), ['d', 'b', 'a', 'c'])
})

function seedLoc() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE posts (key TEXT PRIMARY KEY, location TEXT)')
  const ins = db.prepare('INSERT INTO posts VALUES (?, ?)')
  ins.run('in1', 'Pune')
  ins.run('in2', 'Bangalore, India')
  ins.run('eg', 'Cairo, Egypt')
  ins.run('none', null)
  ins.run('remote', 'Remote')
  return db
}
const LOCS = ['Pune', 'Bangalore, India', 'Cairo, Egypt', null, 'Remote']
const run = (db: Database.Database, c: { sql: string, param: string } | null) =>
  (db.prepare(`SELECT key FROM posts${c ? ` WHERE ${c.sql}` : ''} ORDER BY key`).all(...(c ? [c.param] : [])) as { key: string }[]).map(r => r.key)

test('country include picks every location that names the country', () => {
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, ['India'], 'include')), ['in1', 'in2'])
})

test('country exclude keeps NULL locations — NULL NOT IN (...) would drop them', () => {
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, ['India'], 'exclude')), ['eg', 'none', 'remote'])
})

test('NO_COUNTRY covers NULL and unresolved, in both modes', () => {
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, [NO_COUNTRY], 'include')), ['none', 'remote'])
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, [NO_COUNTRY], 'exclude')), ['eg', 'in1', 'in2'])
})

test('no countries picked means no clause', () => {
  assert.equal(countryClause(LOCS, [], 'exclude'), null)
})
