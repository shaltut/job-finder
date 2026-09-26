// Two devices, two databases, one Gmail account. A recruiter drafted or emailed on device A is invisible
// to device B: B's `contacts` has no row, and B's sweep cannot find them either, because sweep() only
// iterates addresses `contacts` already holds. The draft gate is the one place that asks Gmail about an
// address it has never seen — so it is the one place that can heal the local cache from the only state
// the two devices share. These tests pin that write, and that it never overrules `final`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { followUpPosts, healContact, neverWrittenTo } from '../server/utils/contacts.ts'
import { isClosed, persist } from '../server/utils/drafts.ts'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'
import type { Decision } from '../server/utils/stages.ts'

let dir: string
let db: Database.Database

const NOW = Date.parse('2026-09-19T12:00:00.000Z')

/** What decideStage() returns for row 5: the application is sent and we are waiting on a reply. */
const row5 = (over: Partial<Decision> = {}): Decision => ({
  row: 5,
  stage: 'contacted',
  action: 'none',
  note: 'application sent, no reply yet',
  postsReason: 'named in application',
  followUpDueAt: NOW + 72 * 3600e3,
  ...over
})

const contact = (email: string) =>
  db.prepare('SELECT stage, note, last_sent_at FROM contacts WHERE email = ?').get(email) as
    { stage: string, note: string | null, last_sent_at: number | null } | undefined

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-heal-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a recruiter this device has never seen gets a row from what Gmail says', () => {
  const email = 'other-device@example.com'
  assert.equal(contact(email), undefined, 'the other device wrote to them, so this one knows nothing')

  healContact(db, email, row5(), NOW)

  const c = contact(email)
  assert.equal(c?.stage, 'contacted')
  assert.equal(c?.note, 'application sent, no reply yet')
  // last_sent_at is recovered from the due date the same way the sweep recovers it: 72h before
  assert.equal(c?.last_sent_at, Math.floor((NOW + 72 * 3600e3 - 72 * 3600e3) / 1000))
})

test('healing moves a stale local stage forward to Gmail truth', () => {
  const email = 'stale@example.com'
  db.prepare(`INSERT INTO contacts (email, stage, note) VALUES (?, 'drafted', 'drafted here')`).run(email)

  healContact(db, email, row5(), NOW)

  assert.equal(contact(email)?.stage, 'contacted', 'Gmail is the truth, the cache follows it')
})

test('final is never reset, however the other device left it', () => {
  const email = 'done@example.com'
  db.prepare(`INSERT INTO contacts (email, stage, note) VALUES (?, 'final', 'two emails sent')`).run(email)

  healContact(db, email, row5(), NOW)

  const c = contact(email)
  assert.equal(c?.stage, 'final', 'the two-emails-ever ceiling is a property of the database')
  assert.equal(c?.note, 'two emails sent', 'and its note is not overwritten either')
})

test('a due follow-up heals as contacted, never followed_up: nothing has been drafted yet', () => {
  // closedInGmail() heals through here, so it must apply the same rule as the sweep (cachedStage).
  const email = 'due@example.com'
  healContact(db, email, row5({ row: 6, stage: 'followed_up', action: 'draft-the-follow-up', note: 'silent for 3 days', followUpDueAt: NOW - 3600e3 }), NOW)
  const c = contact(email)
  assert.equal(c?.stage, 'contacted')
  assert.match(c?.note ?? '', /^follow-up due /)
})

test('the no-Gmail cache keeps a contacted recruiter closed to a second application', () => {
  // Without a token, isClosed() is the whole gate. `contacted` means the application went out; Gmail's own
  // gate answers row 5/6 for it, and the cache must not be the one door left open.
  db.prepare(`INSERT INTO contacts (email, stage) VALUES ('sent@example.com', 'contacted')`).run()
  assert.ok(isClosed(db, 'sent@example.com'))
  assert.equal(isClosed(db, 'nobody@example.com'), false, 'a stranger is still open')
})

test('an address lower-cases on the way in, because the schema refuses anything else', () => {
  healContact(db, 'MiXeD@Example.COM', row5(), NOW)
  assert.equal(contact('mixed@example.com')?.stage, 'contacted')
})

test('Unprocessed drops a post whose recruiter has any stage, and keeps one with no address', () => {
  // The Posts view's Unprocessed and the To review KPI both carry this clause. A post whose recruiter
  // was already written to about another role is not waiting on the owner — it rides in the follow-up.
  // The no-address control is the failure worth pinning: json_extract of an empty array is NULL, and a
  // NOT IN over NULL is NULL, so the obvious spelling would silently drop every link-only post.
  const post = (key: string, emails: string[]): ScraperRecord => ({
    op: 'post', key, searchTerm: 'x', author: 'A', authorUrl: 'https://www.linkedin.com/in/a', postUrl: null,
    postedAge: '1h', postedAt: '2026-09-19T09:00:00.000Z', postType: 'hiring', title: 'Role', company: 'Co',
    location: null, remote: true, inScope: true, emails, links: [], phones: [], refIds: [],
    channels: emails.length ? ['email'] : ['link'], score: 7, reason: '', text: 'hiring', flags: []
  } as ScraperRecord)
  const stages = ['drafted', 'contacted', 'followed_up', 'replied', 'final'] as const
  stages.forEach((stage, i) => {
    const email = `stage-${stage}@example.com`
    db.prepare('INSERT INTO contacts (email, stage) VALUES (?, ?)').run(email, stage)
    // the recruiter is the FIRST address; a known address in second place is only a Cc
    applyRecord(db, post(String(i).repeat(40), [email]))
  })
  applyRecord(db, post('a'.repeat(40), ['stranger@example.com', 'stage-final@example.com']))
  applyRecord(db, post('b'.repeat(40), []))

  const kept = (db.prepare(`SELECT key FROM posts p WHERE ${neverWrittenTo('p')} ORDER BY key`).all() as { key: string }[])
    .map(r => r.key[0])
  assert.deepEqual(kept, ['a', 'b'], 'every stage leaves, drafted included; a Cc match and a post with no address stay')
})

test('a follow-up carries the applied role and any newer one — and only what belongs to this address', () => {
  // Before, it carried only never-named posts and gave up without one: 66 of 79 due follow-ups on
  // 2026-09-25 were one-post recruiters whose only post the application had already named.
  const rec = 'fu@acme.example'
  const post = (key: string, emails: string[], score: number): ScraperRecord => ({
    op: 'post', key, searchTerm: 'x', author: 'A', authorUrl: 'https://www.linkedin.com/in/a', postUrl: null,
    postedAge: '1h', postedAt: '2026-09-19T09:00:00.000Z', postType: 'hiring', title: `Role ${key[0]}`, company: 'Co',
    location: null, remote: true, inScope: true, emails, links: [], phones: [], refIds: [],
    channels: ['email'], score, reason: '', text: 'hiring', flags: []
  } as ScraperRecord)
  const app = db.prepare('INSERT INTO applications (key, verdict, reason, recruiter_email, gmail_draft_id) VALUES (?, ?, ?, ?, ?)')
  const k = (c: string) => c.repeat(40)
  applyRecord(db, post(k('p'), [rec], 5))
  app.run(k('p'), 'drafted', 'named in application; the role', rec, 'draft-app')
  applyRecord(db, post(k('q'), [rec], 8)) // posted since, never named
  applyRecord(db, post(k('r'), [rec], 7))
  app.run(k('r'), 'drafted', 'named in follow-up; had its second email', rec, 'draft-fu')
  applyRecord(db, post(k('s'), ['other@x.example', rec], 9))
  app.run(k('s'), 'drafted', 'named in application; to someone else', 'other@x.example', 'x')
  applyRecord(db, post(k('t'), [rec], 9))
  db.prepare('UPDATE posts SET dismissed_at = 1 WHERE key = ?').run(k('t'))
  // an application DRAFTED earlier and deleted unsent: its rows remain, but that email never went out
  applyRecord(db, post(k('u'), [rec], 9))
  db.prepare(`INSERT INTO applications (key, verdict, reason, recruiter_email, gmail_draft_id, created_at)
    VALUES (?, 'drafted', 'named in application; deleted unsent', ?, 'draft-old', unixepoch() - 86400)`).run(k('u'), rec)
  // a post the owner added to the exclude list after applying
  applyRecord(db, post(k('v'), [rec], 9))
  db.prepare(`UPDATE posts SET flags = '["excluded"]' WHERE key = ?`).run(k('v'))

  const sentAt = Date.now() + 60_000 // the application that went out: draft-app, drafted just before this
  const got = followUpPosts(db, 'FU@Acme.example', sentAt)
  assert.deepEqual(got.map(p => [p.key[0], p.named]), [['p', true], ['q', false]],
    'the role of the application that was sent first, then the newer one; not the followed-up, Cc-only, dismissed, '
    + 'deleted-draft or excluded posts')

  // and persisting that follow-up keeps the application's own record, while promoting the recruiter
  db.prepare(`INSERT INTO contacts (email, stage) VALUES (?, 'contacted')`).run(rec)
  persist(db, { mode: 'follow-up', recruiterEmail: rec, posts: got }, { report: '', results: [
    { key: k('p'), verdict: 'drafted', reason: 'named in follow-up; still interested', body: 'B' },
    { key: k('q'), verdict: 'drafted', reason: 'named in follow-up; newer role' }
  ] }, 'draft-new')
  const row = (key: string) => db.prepare('SELECT reason, gmail_draft_id FROM applications WHERE key = ?').get(key) as { reason: string, gmail_draft_id: string }
  assert.deepEqual(row(k('p')), { reason: 'named in application; the role', gmail_draft_id: 'draft-app' }, 'the application row is untouched')
  assert.equal(row(k('q')).reason, 'named in follow-up; newer role')
  assert.equal(contact(rec)?.stage, 'followed_up', 'a draft now exists, so the recruiter is followed up')
})
