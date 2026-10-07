// The inbox's reads and writes. Database only — no Gmail — so test/inbox-store.test.ts can reach it.
// See docs/superpowers/specs/2026-10-07-inbox-replies-design.md.
import type Database from 'better-sqlite3'

export interface Inbound { messageId: string, threadId: string, contactEmail: string, from: string, subject: string, body: string, receivedAt: number }
export interface InboxRow {
  message_id: string
  thread_id: string
  contact_email: string
  from_addr: string
  subject: string
  body: string
  received_at: number
  read_at: number | null
  reply_status: 'queued' | 'drafted' | 'failed' | 'superseded' | null
  reply_draft_id: string | null
  reply_draft_msg_id: string | null
  questions: string | null
  note: string | null
}

const now = () => Math.floor(Date.now() / 1000)

export function knownIds(db: Database.Database, ids: string[]): Set<string> {
  if (!ids.length) return new Set()
  const rows = db.prepare(`SELECT message_id FROM inbox WHERE message_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as { message_id: string }[]
  return new Set(rows.map(r => r.message_id))
}

/**
 * A new reply, and its recruiter marked `replied` — whoever in the thread wrote it. A colleague at another
 * domain used to read as 'other' in classifyMessage(), leaving the recruiter `contacted` and due a follow-up.
 * `final` is never reset.
 */
export function storeInbound(db: Database.Database, m: Inbound): boolean {
  const added = db.prepare(`
    INSERT OR IGNORE INTO inbox (message_id, thread_id, contact_email, from_addr, subject, body, received_at)
    VALUES (@messageId, @threadId, @contactEmail, @from, @subject, @body, @receivedAt)
  `).run({ ...m, contactEmail: m.contactEmail.toLowerCase() }).changes > 0
  if (added) {
    db.prepare(`UPDATE contacts SET stage = 'replied', note = ?, updated_at = ? WHERE email = ? AND stage <> 'final'`)
      .run(`replied ${new Date(m.receivedAt * 1000).toISOString().slice(0, 10)}`, now(), m.contactEmail.toLowerCase())
  }
  return added
}

export const lastPoll = (db: Database.Database): number | null =>
  (db.prepare('SELECT last_poll_at FROM inbox_state WHERE id = 1').get() as { last_poll_at: number | null } | undefined)?.last_poll_at ?? null

export function setLastPoll(db: Database.Database, sec: number) {
  db.prepare('INSERT INTO inbox_state (id, last_poll_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_poll_at = excluded.last_poll_at').run(sec)
}

export const inboxRow = (db: Database.Database, messageId: string) =>
  db.prepare('SELECT * FROM inbox WHERE message_id = ?').get(messageId) as InboxRow | undefined

export const latestInThread = (db: Database.Database, threadId: string) =>
  db.prepare('SELECT * FROM inbox WHERE thread_id = ? ORDER BY received_at DESC LIMIT 1').get(threadId) as InboxRow | undefined

export function priorReplyDrafts(db: Database.Database, threadId: string) {
  return (db.prepare(`SELECT message_id, reply_draft_id, reply_draft_msg_id FROM inbox
    WHERE thread_id = ? AND reply_status = 'drafted' AND reply_draft_id IS NOT NULL`).all(threadId) as
    { message_id: string, reply_draft_id: string, reply_draft_msg_id: string | null }[])
    .map(r => ({ messageId: r.message_id, draftId: r.reply_draft_id, draftMsgId: r.reply_draft_msg_id }))
}

export function markReply(db: Database.Database, messageId: string, status: 'queued' | 'failed' | 'superseded', note: string | null = null) {
  db.prepare('UPDATE inbox SET reply_status = ?, note = ? WHERE message_id = ?').run(status, note, messageId)
}

/**
 * The draft the reply job created. `app_drafts` gets it as mode 'reply' — the sender lane never selects
 * those — and the upsert overrides an 'apply' label the sender's adoption step may have written first.
 */
export function recordReplyDraft(db: Database.Database, r: { messageId: string, draftId: string, draftMsgId: string | null, to: string, questions: string[], note: string | null }) {
  db.transaction(() => {
    db.prepare(`UPDATE inbox SET reply_status = 'drafted', reply_draft_id = ?, reply_draft_msg_id = ?, questions = ?, note = ? WHERE message_id = ?`)
      .run(r.draftId, r.draftMsgId, JSON.stringify(r.questions), r.note, r.messageId)
    db.prepare(`INSERT INTO app_drafts (draft_id, email, mode, created_at) VALUES (?, ?, 'reply', ?) ON CONFLICT (draft_id) DO UPDATE SET mode = 'reply'`)
      .run(r.draftId, r.to.toLowerCase(), now())
  })()
}

export const listInbox = (db: Database.Database, limit = 200) =>
  db.prepare('SELECT * FROM inbox ORDER BY received_at DESC LIMIT ?').all(limit) as InboxRow[]

export const unreadCount = (db: Database.Database): number =>
  (db.prepare('SELECT count(*) n FROM inbox WHERE read_at IS NULL').get() as { n: number }).n

export function markRead(db: Database.Database, messageId: string) {
  db.prepare('UPDATE inbox SET read_at = ? WHERE message_id = ? AND read_at IS NULL').run(now(), messageId)
}
