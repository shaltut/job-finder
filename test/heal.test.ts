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
import { healContact } from '../server/utils/contacts.ts'
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

test('an address lower-cases on the way in, because the schema refuses anything else', () => {
  healContact(db, 'MiXeD@Example.COM', row5(), NOW)
  assert.equal(contact('mixed@example.com')?.stage, 'contacted')
})
