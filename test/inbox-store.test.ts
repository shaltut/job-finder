// The inbox's writes, against a migrated database. See docs/superpowers/specs/2026-10-07-inbox-replies-design.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import {
  knownIds, lastPoll, latestInThread, markRead, priorReplyDrafts, recordReplyDraft, setLastPoll, storeInbound, strandedQueued, unreadCount
} from '../server/utils/inbox-store.ts'

let dir: string
let db: Database.Database
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-inbox-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

const m = (id: string, thread = 't1', at = 100) => ({
  messageId: id, threadId: thread, contactEmail: 'hr@acme.com', from: 'Lee <lee@other.io>', subject: 'Re: Role', body: 'hi', receivedAt: at
})

test('a stored reply marks its recruiter replied, but never reopens a final one', () => {
  db.prepare(`INSERT INTO contacts (email, stage, updated_at) VALUES ('hr@acme.com', 'contacted', 0), ('done@acme.com', 'final', 0)`).run()
  assert.equal(storeInbound(db, m('a')), true)
  assert.equal(storeInbound(db, m('a')), false, 'the same message twice is one row')
  assert.equal((db.prepare(`SELECT stage FROM contacts WHERE email = 'hr@acme.com'`).get() as { stage: string }).stage, 'replied')
  storeInbound(db, { ...m('z', 't9'), contactEmail: 'done@acme.com' })
  assert.equal((db.prepare(`SELECT stage FROM contacts WHERE email = 'done@acme.com'`).get() as { stage: string }).stage, 'final')
  assert.deepEqual([...knownIds(db, ['a', 'nope'])], ['a'])
})

test('unread count and the newest message of a thread', () => {
  storeInbound(db, m('b', 't1', 200))
  assert.equal(latestInThread(db, 't1')!.message_id, 'b')
  const before = unreadCount(db)
  markRead(db, 'b')
  assert.equal(unreadCount(db), before - 1)
})

test('a reply draft is recorded as mode reply even if the sender adopted it first', () => {
  // the sender's adoption step labels any unknown draft to a known recruiter 'apply'; the reply job's
  // upsert must win, or the lane would treat a reply as an application
  db.prepare(`INSERT INTO app_drafts (draft_id, email, mode, created_at) VALUES ('d1', 'hr@acme.com', 'apply', 0)`).run()
  recordReplyDraft(db, { messageId: 'b', draftId: 'd1', draftMsgId: 'dm1', to: 'hr@acme.com', questions: ['interview time'], note: null })
  assert.equal((db.prepare(`SELECT mode FROM app_drafts WHERE draft_id = 'd1'`).get() as { mode: string }).mode, 'reply')
  assert.deepEqual(priorReplyDrafts(db, 't1'), [{ messageId: 'b', draftId: 'd1', draftMsgId: 'dm1' }])
})

test('the last poll time round-trips', () => {
  assert.equal(lastPoll(db), null)
  setLastPoll(db, 500)
  setLastPoll(db, 600)
  assert.equal(lastPoll(db), 600)
})

test('strandedQueued returns the newest queued message per thread only', () => {
  storeInbound(db, m('s1', 'ts', 10))
  storeInbound(db, m('s2', 'ts', 20))
  storeInbound(db, m('s3', 'tdone', 30))
  db.prepare(`UPDATE inbox SET reply_status = 'queued' WHERE message_id IN ('s1', 's2')`).run()
  db.prepare(`UPDATE inbox SET reply_status = 'drafted' WHERE message_id = 's3'`).run()
  const mine = strandedQueued(db).filter(r => r.threadId === 'ts' || r.threadId === 'tdone')
  assert.deepEqual(mine, [{ messageId: 's2', threadId: 'ts' }])
})
