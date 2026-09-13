// Dismissing a post is the owner's triage: it hides the row and, more importantly, takes the post out of
// every query that decides who receives an email. These tests run the real predicates from
// server/utils/jobs.ts, server/utils/sync.ts and server/api/stats.get.ts against a migrated database,
// because a dismissal that silently comes back — after a re-scrape, a --rescore, or through a queue that
// forgot its clause — means emailing a recruiter about a role the owner already threw away.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { applyRecord, setDismissed, type ScraperRecord } from '../server/utils/ingest.ts'

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
  score: 8,
  reason: 'Match: Vue, Nuxt; Gaps: none',
  text: 'We are hiring a Vue lead. Send CV to hr@acme.sa',
  flags: [],
  ...over
} as ScraperRecord)

const dismissedAt = (key: string) =>
  (db.prepare('SELECT dismissed_at FROM posts WHERE key = ?').get(key) as { dismissed_at: number | null }).dismissed_at

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

test('dismissing stamps a timestamp and restoring clears it', () => {
  const key = 'b'.repeat(40)
  applyRecord(db, post({ key }))
  assert.equal(dismissedAt(key), null, 'a freshly scraped post is live')

  assert.equal(setDismissed(db, [key], true), 1)
  assert.equal(typeof dismissedAt(key), 'number')

  // the endpoint is symmetric: the same call with dismissed:false is the Undo
  assert.equal(setDismissed(db, [key], false), 1)
  assert.equal(dismissedAt(key), null)
})

test('one call dismisses many posts, and unknown keys are simply not found', () => {
  const keys = ['c'.repeat(40), 'd'.repeat(40)]
  keys.forEach(key => applyRecord(db, post({ key })))

  assert.equal(setDismissed(db, [...keys, 'f'.repeat(40)], true), 2, 'only the rows that exist are counted')
  keys.forEach(key => assert.ok(dismissedAt(key)))
  assert.equal(setDismissed(db, [], true), 0, 'an empty selection is a no-op, not a table-wide UPDATE')
})

test('a re-scraped post stays dismissed', () => {
  const key = 'e'.repeat(40)
  applyRecord(db, post({ key }))
  setDismissed(db, [key], true)

  // the same card comes back on the next run; the insert's ON CONFLICT DO NOTHING is what protects this
  assert.equal(applyRecord(db, post({ key })), null)
  assert.ok(dismissedAt(key), 'a scrape must never resurrect a post the owner threw away')
})

test('--rescore and --reflag leave a dismissal alone', () => {
  const key = '1'.repeat(40)
  applyRecord(db, post({ key }))
  setDismissed(db, [key], true)
  const stamped = dismissedAt(key)

  applyRecord(db, {
    op: 'update', key, postType: 'hiring', title: 'Lead Frontend Engineer', company: 'Acme',
    location: 'Riyadh', remote: true, inScope: true, score: 9, reason: 'Match: Vue, Nuxt'
  })
  applyRecord(db, { op: 'reflag', key, flags: ['junior'], postedAt: null })

  assert.equal(dismissedAt(key), stamped, 'maintenance rescores triage, it does not undo it')
})

test('the drafter queue skips a dismissed post that is otherwise perfect', () => {
  const key = '2'.repeat(40)
  applyRecord(db, post({ key, emails: ['hr@perfect.sa'], score: 9, flags: [] }))

  // the exact predicate from server/utils/jobs.ts — the query that decides who receives an email
  const queued = () => (db.prepare(`
    SELECT count(*) n FROM posts p LEFT JOIN applications a ON a.key = p.key
    WHERE p.key = ? AND a.key IS NULL
      AND json_array_length(p.emails) > 0
      AND coalesce(p.post_type, 'hiring') = 'hiring'
      AND json_array_length(p.flags) = 0
      AND p.score >= 6
      AND p.dismissed_at IS NULL
  `).get(key) as { n: number }).n

  assert.equal(queued(), 1)
  setDismissed(db, [key], true)
  assert.equal(queued(), 0, 'dismiss must mean "do not email about this", not merely "hide the row"')
})

test('the follow-up sweep never names a dismissed post', () => {
  const key = '3'.repeat(40)
  const email = 'hr@followup.sa'
  applyRecord(db, post({ key, emails: [email] }))
  setDismissed(db, [key], true)

  // server/utils/sync.ts: a dismissed post has no 'named in ...' application row, so without the
  // dismissed_at clause it would be offered up as an unmentioned role in the next follow-up email
  const rows = db.prepare(`
    SELECT p.key FROM posts p LEFT JOIN applications a ON a.key = p.key
    WHERE EXISTS (SELECT 1 FROM json_each(p.emails) WHERE value = ?)
      AND coalesce(p.post_type, 'hiring') = 'hiring'
      AND (a.key IS NULL OR a.reason NOT LIKE 'named in %')
      AND p.dismissed_at IS NULL
  `).all(email)

  assert.equal(rows.length, 0)
})

test('the usable KPI drops a dismissed post', () => {
  const key = '4'.repeat(40)
  applyRecord(db, post({ key, score: 8, inScope: true, remote: true, flags: [] }))

  // the predicate shared by server/api/stats.get.ts and server/api/yield.get.ts
  const usable = () => (db.prepare(`
    SELECT count(*) n FROM posts
    WHERE key = ? AND score >= 6 AND coalesce(post_type, 'hiring') = 'hiring'
      AND json_array_length(flags) = 0 AND (in_scope = 1 OR remote = 1)
      AND dismissed_at IS NULL
  `).get(key) as { n: number }).n

  assert.equal(usable(), 1)
  setDismissed(db, [key], true)
  assert.equal(usable(), 0, 'the headline number must agree with the list underneath it')
})

test('a drafted post can still be dismissed, and its application row is untouched', () => {
  const key = '5'.repeat(40)
  applyRecord(db, post({ key }))
  db.prepare(`INSERT INTO applications (key, verdict, reason, recruiter_email) VALUES (?, 'drafted', ?, ?)`)
    .run(key, 'named in application; Vue depth', 'hr@acme.sa')

  setDismissed(db, [key], true)

  const app = db.prepare('SELECT verdict, reason FROM applications WHERE key = ?').get(key) as Record<string, string>
  assert.equal(app.verdict, 'drafted')
  assert.match(app.reason, /^named in application/, 'dismiss is triage, not a verdict: the sweep still needs this prefix')
  assert.ok(dismissedAt(key))
})
