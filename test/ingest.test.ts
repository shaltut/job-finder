import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'

let dir: string
let dbPath: string
let db: Database.Database

const post = (over: Partial<Record<string, unknown>> = {}): ScraperRecord => ({
  op: 'post',
  key: 'a'.repeat(40),
  searchTerm: 'vue nuxt developer',
  author: 'Heba Zaki',
  authorUrl: 'https://www.linkedin.com/in/heba',
  postedAge: '3h',
  postedAt: '2026-09-10T09:00:00.000Z',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: 'Riyadh',
  remote: true,
  inScope: true,
  emails: ['hr@acme.sa'],
  score: 8,
  reason: 'Match: Vue, Nuxt; Gaps: none',
  text: 'We are hiring a Vue lead. Send CV to hr@acme.sa',
  flags: [],
  ...over
} as ScraperRecord)

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-'))
  dbPath = join(dir, 'test.db')
  // build the schema the same way the app does, from the generated migration
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: dbPath }, stdio: 'ignore' })
  db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a post record inserts, and arrays land as queryable JSON', () => {
  assert.equal(applyRecord(db, post()), 'post')
  const row = db.prepare('SELECT * FROM posts WHERE key = ?').get('a'.repeat(40)) as Record<string, unknown>
  assert.equal(row.title, 'Senior Frontend Engineer')
  assert.equal(row.remote, 1)
  assert.deepEqual(JSON.parse(row.emails as string), ['hr@acme.sa'])
  // timestamps are stored as epoch SECONDS, matching drizzle's { mode: 'timestamp' }
  assert.equal(row.posted_at, Math.floor(Date.parse('2026-09-10T09:00:00.000Z') / 1000))
})

test('json_each finds a post by one of its emails (the Postgres ANY() replacement)', () => {
  const found = db.prepare(
    'SELECT key FROM posts WHERE EXISTS (SELECT 1 FROM json_each(posts.emails) WHERE value = ?)'
  ).all('hr@acme.sa')
  assert.equal(found.length, 1)
})

test('json_array_length replaces cardinality() for the unflagged filter', () => {
  applyRecord(db, post({ key: 'b'.repeat(40), flags: ['junior'], emails: ['x@y.com'] }))
  const unflagged = db.prepare('SELECT count(*) AS n FROM posts WHERE json_array_length(flags) = 0').get() as { n: number }
  assert.equal(unflagged.n, 1)
})

test('re-inserting the same key is a no-op, so a re-scrape never duplicates or overwrites', () => {
  assert.equal(applyRecord(db, post({ title: 'CHANGED' })), null)
  const row = db.prepare('SELECT title FROM posts WHERE key = ?').get('a'.repeat(40)) as { title: string }
  assert.equal(row.title, 'Senior Frontend Engineer')
})

test('an update record rescores in place', () => {
  assert.equal(applyRecord(db, { op: 'update', key: 'a'.repeat(40), title: 'Frontend Lead', company: 'Acme', location: 'Riyadh', remote: false, inScope: true, score: 9, reason: 'Match: Nuxt; Gaps: none' }), 'update')
  const row = db.prepare('SELECT title, score, remote FROM posts WHERE key = ?').get('a'.repeat(40)) as Record<string, unknown>
  assert.equal(row.title, 'Frontend Lead')
  assert.equal(row.score, 9)
  assert.equal(row.remote, 0)
})

test('a reflag record replaces flags and backfills posted_at without clobbering it', () => {
  const before = db.prepare('SELECT posted_at FROM posts WHERE key = ?').get('a'.repeat(40)) as { posted_at: number }
  applyRecord(db, { op: 'reflag', key: 'a'.repeat(40), flags: ['night-shift'], postedAt: '2020-01-01T00:00:00.000Z' })
  const row = db.prepare('SELECT flags, posted_at FROM posts WHERE key = ?').get('a'.repeat(40)) as Record<string, unknown>
  assert.deepEqual(JSON.parse(row.flags as string), ['night-shift'])
  assert.equal(row.posted_at, before.posted_at, 'coalesce must not overwrite an existing posted_at')
})

test('applications cannot reference a post that does not exist', () => {
  assert.throws(
    () => db.prepare('INSERT INTO applications (key, verdict) VALUES (?, ?)').run('c'.repeat(40), 'skipped'),
    /FOREIGN KEY/
  )
})

test('contacts upsert never resets a recruiter who is \'final\'', () => {
  db.prepare('INSERT INTO contacts (email, stage) VALUES (?, ?)').run('rec@acme.sa', 'final')
  db.prepare(`
    INSERT INTO contacts (email, stage) VALUES (?, ?)
    ON CONFLICT (email) DO UPDATE SET stage = excluded.stage WHERE contacts.stage <> 'final'
  `).run('rec@acme.sa', 'drafted')
  const row = db.prepare('SELECT stage FROM contacts WHERE email = ?').get('rec@acme.sa') as { stage: string }
  assert.equal(row.stage, 'final', 'final is enforced by the database, not by prose')
})
