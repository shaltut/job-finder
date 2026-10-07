// The inbox's writes, against a migrated database. See docs/superpowers/specs/2026-10-07-inbox-replies-design.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import {
  answerThread, knownIds, lastPoll, latestInThread, markAllRead, markAnswered, markRead, openThreads, markReply, priorReplyDrafts, recordReplyDraft, setLastPoll, storeInbound, strandedQueued, supersedeQueued, unreadCount
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

test('a job that drafts on the newest message leaves nothing stranded in the thread', () => {
  storeInbound(db, m('x1', 'tx', 10))
  storeInbound(db, m('x2', 'tx', 20))
  db.prepare(`UPDATE inbox SET reply_status = 'queued' WHERE message_id IN ('x1', 'x2')`).run()
  recordReplyDraft(db, { messageId: 'x2', draftId: 'dx', draftMsgId: 'dmx', to: 'hr@acme.com', questions: [], note: null })
  supersedeQueued(db, 'tx', 'x2')
  assert.deepEqual(strandedQueued(db).filter(r => r.threadId === 'tx'), [])
})

test('a Re-draft on the same message still sees the draft that message holds', () => {
  // reply.post.ts marks the pressed row `queued`; a filter on `drafted` alone hid its draft, so the new one
  // overwrote reply_draft_id and the old draft stayed in Gmail, untracked
  storeInbound(db, m('r1', 'tr', 10))
  recordReplyDraft(db, { messageId: 'r1', draftId: 'dr1', draftMsgId: 'dmr1', to: 'hr@acme.com', questions: [], note: null })
  markReply(db, 'r1', 'queued')
  assert.deepEqual(priorReplyDrafts(db, 'tr'), [{ messageId: 'r1', draftId: 'dr1', draftMsgId: 'dmr1' }])
  markReply(db, 'r1', 'failed', 'boom')
  assert.equal(priorReplyDrafts(db, 'tr').length, 1, 'a failed re-draft still holds the earlier draft')
  markReply(db, 'r1', 'superseded')
  assert.deepEqual(priorReplyDrafts(db, 'tr'), [], 'an earlier run already handled it')
})

test('an answered message leaves the reply queue with a note saying why', () => {
  storeInbound(db, m('q1', 'tq', 10))
  markReply(db, 'q1', 'queued')
  markAnswered(db, 'q1')
  const r = latestInThread(db, 'tq')!
  assert.deepEqual([r.reply_status, r.note], ['answered', 'you replied in Gmail'])
  assert.ok(r.read_at, 'an answered message is read')
  assert.deepEqual(strandedQueued(db).filter(x => x.threadId === 'tq'), [], 'and no poll re-offers it')
})

test('a thread whose newest reply was drafted or left alone is open until the owner answers it', () => {
  storeInbound(db, m('o1', 'to', 10))
  storeInbound(db, m('o2', 'to', 20))
  recordReplyDraft(db, { messageId: 'o2', draftId: 'do2', draftMsgId: 'dmo2', to: 'hr@acme.com', questions: [], note: null })
  storeInbound(db, m('w1', 'tw', 10))
  markReply(db, 'w1', 'queued')
  const open = openThreads(db).filter(t => ['to', 'tw'].includes(t.threadId))
  assert.deepEqual(open, [{ threadId: 'to', messageId: 'o2', receivedAt: 20 }], 'newest row only; a queued thread belongs to the drafter')

  answerThread(db, 'to', 20)
  assert.deepEqual(openThreads(db).filter(t => t.threadId === 'to'), [], 'answered threads stop being re-read')
  for (const id of ['o1', 'o2']) {
    const r = db.prepare('SELECT reply_status, read_at FROM inbox WHERE message_id = ?').get(id) as { reply_status: string, read_at: number | null }
    assert.equal(r.reply_status, 'answered')
    assert.ok(r.read_at, `${id} is read`)
  }
  assert.equal((db.prepare(`SELECT reply_status FROM inbox WHERE message_id = 'w1'`).get() as { reply_status: string }).reply_status, 'queued', 'other threads untouched')
})

test('a newer reply after the owner answered is not swallowed', () => {
  storeInbound(db, m('n1', 'tn', 10))
  storeInbound(db, m('n2', 'tn', 30))
  answerThread(db, 'tn', 10)
  const r = db.prepare(`SELECT reply_status FROM inbox WHERE message_id = 'n2'`).get() as { reply_status: string | null }
  assert.equal(r.reply_status, null, 'only messages up to the answered one')
})

test('mark all read clears the badge', () => {
  storeInbound(db, m('ar1', 'tar', 10))
  assert.ok(unreadCount(db) > 0)
  markAllRead(db)
  assert.equal(unreadCount(db), 0)
})
