// The SQL text builders behind /api/posts, run against a real SQLite so the ORDER BY and WHERE are
// tested by what the database does with them, not by how the strings look.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { orderSql } from '../server/utils/posts-query.ts'

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
