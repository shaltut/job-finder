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
  postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7503713927348764672/',
  postedAge: '3h',
  postedAt: '2026-09-10T09:00:00.000Z',
  postType: 'hiring',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: 'Riyadh',
  remote: true,
  inScope: true,
  emails: ['hr@acme.sa'],
  links: [],
  phones: [],
  refIds: [],
  channels: ['email'],
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
  assert.equal(applyRecord(db, { op: 'update', key: 'a'.repeat(40), postType: 'hiring', title: 'Frontend Lead', company: 'Acme', location: 'Riyadh', remote: false, inScope: true, score: 9, reason: 'Match: Nuxt; Gaps: none' }), 'update')
  const row = db.prepare('SELECT title, score, remote FROM posts WHERE key = ?').get('a'.repeat(40)) as Record<string, unknown>
  assert.equal(row.title, 'Frontend Lead')
  assert.equal(row.score, 9)
  assert.equal(row.remote, 0)
})

test('post_type round-trips on insert, and --rescore is the path that backfills it', () => {
  const key = 'e'.repeat(40)
  applyRecord(db, post({ key, postType: 'seeking', score: 0, text: 'I am open to work. me@example.com' }))
  assert.equal((db.prepare('SELECT post_type FROM posts WHERE key = ?').get(key) as Record<string, unknown>).post_type, 'seeking')

  // a row written before the column existed carries NULL, and every consumer reads that as 'hiring'
  db.prepare('UPDATE posts SET post_type = NULL WHERE key = ?').run(key)
  const unclassified = db.prepare(`SELECT count(*) n FROM posts WHERE key = ? AND coalesce(post_type, 'hiring') = 'hiring'`).get(key) as { n: number }
  assert.equal(unclassified.n, 1, 'NULL must behave as hiring, or a migration empties the UI')

  // --rescore emits op:'update', which is the only path that can fill it in
  applyRecord(db, { op: 'update', key, postType: 'seeking', title: 'unknown', company: 'unknown', location: 'unknown', remote: false, inScope: false, score: 0, reason: 'The author is advertising themselves for work.' })
  const after = db.prepare('SELECT post_type, score FROM posts WHERE key = ?').get(key) as Record<string, unknown>
  assert.equal(after.post_type, 'seeking')
  assert.equal(after.score, 0)
})

test('the drafter queue and the usable KPI both exclude a non-hiring post', () => {
  const key = 'f'.repeat(40)
  applyRecord(db, post({ key, postType: 'seeking', score: 7, inScope: true, remote: true, flags: [], emails: ['seeker@example.com'] }))
  // the exact predicate shared by server/api/stats.get.ts and server/utils/jobs.ts
  const usable = db.prepare(`
    SELECT count(*) n FROM posts
    WHERE key = ? AND score >= 6 AND coalesce(post_type, 'hiring') = 'hiring'
      AND json_array_length(flags) = 0 AND (in_scope = 1 OR remote = 1)
  `).get(key) as { n: number }
  assert.equal(usable.n, 0, 'a job seeker scoring 7 must never reach the queue that emails people')
})

test('an excluded post is out of the drafter queue, however well it scored', () => {
  // The case this was built for: a post scoring 9 with a real contact route, from a source the owner
  // has ruled out. Only the flag stands between it and an application email.
  const key = 'e'.repeat(40)
  applyRecord(db, post({ key, postType: 'hiring', score: 9, inScope: true, remote: true, emails: ['hr@example.com'], flags: ['excluded'] }))
  const n = db.prepare(`
    SELECT count(*) n FROM posts p LEFT JOIN applications a ON a.key = p.key
    WHERE p.key = ? AND a.key IS NULL
      AND json_array_length(p.emails) > 0
      AND coalesce(p.post_type, 'hiring') = 'hiring'
      AND json_array_length(p.flags) = 0
      AND p.score >= 6 AND p.dismissed_at IS NULL AND p.applied_at IS NULL
  `).get(key) as { n: number }
  assert.equal(n.n, 0, 'an excluded post must never reach the drafter')

  // and removing the rule brings it back — the reversibility that made this a flag, not a deletion
  applyRecord(db, { op: 'reflag', key, flags: [], postedAt: null })
  const back = db.prepare('SELECT count(*) n FROM posts WHERE key = ? AND json_array_length(flags) = 0').get(key) as { n: number }
  assert.equal(back.n, 1)
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

test('the post URL is stored on insert, and a conflicting record changes nothing', () => {
  const key = 'c'.repeat(40)
  const url = 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7503685320660590592/'
  assert.equal(applyRecord(db, post({ key, postUrl: url })), 'post')
  assert.equal((db.prepare('SELECT post_url FROM posts WHERE key = ?').get(key) as { post_url: string }).post_url, url)

  // ON CONFLICT DO NOTHING: a re-ingest neither counts as a new row nor clears the URL already stored
  assert.equal(applyRecord(db, post({ key, postUrl: null, title: 'CHANGED' })), null)
  const row = db.prepare('SELECT post_url, title FROM posts WHERE key = ?').get(key) as { post_url: string, title: string }
  assert.equal(row.post_url, url)
  assert.equal(row.title, 'Senior Frontend Engineer')
})

test('a posturl record fills a missing URL and never overwrites one', () => {
  const key = 'd'.repeat(40)
  const url = 'https://www.linkedin.com/feed/update/urn:li:activity:7503894663280623621/'
  applyRecord(db, post({ key, postUrl: null }))

  // the scraper emits this for a post it already knows, which it skips before scoring
  assert.equal(applyRecord(db, { op: 'posturl', key, postUrl: url }), 'update')
  assert.equal((db.prepare('SELECT post_url FROM posts WHERE key = ?').get(key) as { post_url: string }).post_url, url)

  // seen again on a later run: the row already has a URL, so nothing changes and nothing is counted
  assert.equal(applyRecord(db, { op: 'posturl', key, postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' }), null)
  assert.equal((db.prepare('SELECT post_url FROM posts WHERE key = ?').get(key) as { post_url: string }).post_url, url)

  // an unknown key touches nothing
  assert.equal(applyRecord(db, { op: 'posturl', key: 'f'.repeat(40), postUrl: url }), null)
})
