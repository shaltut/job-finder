// The inbox: a 5-minute poll for replies in threads the owner started, and the job that drafts an answer.
// See docs/superpowers/specs/2026-10-07-inbox-replies-design.md.
import type Database from 'better-sqlite3'
import { readConfig } from './config'
import { runReplyDrafter, type ReplyRequest } from './drafter'
import { signature } from './drafts'
import { createDraft, gmail, gmailStatus, renderHtml, replyHeaders } from './gmail'
import { headerOf, isInbound, isUnedited, ownerAnswered, plainBody, replyRecipients, shouldSavePoll, stripQuoted, threadContact, type ThreadMsg } from './inbox-core'
import { inboxRow, knownIds, lastPoll, latestInThread, markAnswered, markReply, noteReply, priorReplyDrafts, recordReplyDraft, setLastPoll, supersedeQueued, storeInbound } from './inbox-store'
import { openWritableDb } from './ingest'
import { classifyMessage } from './stages'
import { gmailRead } from './sync'

// the last poll's start, per worker: inbox_state is written only now and then (inbox-core shouldSavePoll)
const g = globalThis as { __jobfinderInboxLastPoll?: number }

const BACKFILL = 'newer_than:30d'
const BASE = '-from:me -in:draft -in:chats'

/** Every message id the search returns, across pages. */
async function searchIds(q: string): Promise<{ id: string, threadId: string }[]> {
  const out: { id: string, threadId: string }[] = []
  let page: string | undefined
  do {
    const r = await gmailRead(() => gmail<{ messages?: { id: string, threadId: string }[], nextPageToken?: string }>(
      `messages?q=${encodeURIComponent(q)}&maxResults=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`
    ))
    out.push(...(r.messages ?? []))
    page = r.nextPageToken
  } while (page)
  return out
}

/**
 * One poll. Searches inbound mail since the last poll (an hour of overlap, so a message Gmail indexed late
 * is not missed), reads each new message's thread once, and stores the human replies in threads the owner
 * started with a known recruiter. `onThread` is called, as each thread is stored, with its newest message, so a poll that dies later has
 * already handed those threads to the reply drafter.
 */
export async function pollInbox(db: Database.Database, selfEmail: string, log: (s: string) => void,
  onThread: (t: { messageId: string, threadId: string }) => void) {
  const started = Math.floor(Date.now() / 1000)
  const saved = lastPoll(db)
  const since = g.__jobfinderInboxLastPoll ?? saved
  const found = await searchIds(`${BASE} ${since ? `after:${since - 3600}` : BACKFILL}`)
  const known = knownIds(db, found.map(f => f.id))
  const fresh = found.filter(f => !known.has(f.id))
  const contacts = new Set((db.prepare('SELECT email FROM contacts').all() as { email: string }[]).map(r => r.email))

  const byThread = new Map<string, Set<string>>()
  for (const f of fresh) byThread.set(f.threadId, (byThread.get(f.threadId) ?? new Set()).add(f.id))

  let stored = 0
  let threads = 0
  for (const [threadId, ids] of byThread) {
    try {
      const thread = await gmailRead(() => gmail<{ messages?: ThreadMsg[] }>(`threads/${threadId}?format=full`))
      const messages = thread.messages ?? []
      const contact = threadContact(messages, selfEmail, contacts)
      if (!contact) continue
      let newest: ThreadMsg | null = null
      for (const m of messages) {
        if (!ids.has(m.id) || !isInbound(m, selfEmail)) continue
        const date = Number(m.internalDate) || 0
        const kind = classifyMessage(
          { id: m.id, threadId, from: headerOf(m, 'From'), subject: headerOf(m, 'Subject'), snippet: m.snippet || '', date },
          selfEmail, contact
        )
        if (kind === 'bounce' || kind === 'auto-reply' || kind === 'outgoing') continue
        const added = storeInbound(db, {
          messageId: m.id, threadId, contactEmail: contact, from: headerOf(m, 'From'), subject: headerOf(m, 'Subject'),
          body: stripQuoted(plainBody(m.payload)) || m.snippet || '', receivedAt: Math.floor(date / 1000)
        })
        if (!added) continue
        stored++
        if (!newest || date > Number(newest.internalDate)) newest = m
      }
      if (newest && ownerAnswered(messages, selfEmail, newest.id)) {
        markAnswered(db, newest.id)
      } else if (newest) {
        markReply(db, newest.id, 'queued')
        threads++
        onThread({ messageId: newest.id, threadId })
      }
    } catch (e) {
      log(`inbox: thread ${threadId} skipped — ${(e as Error).message}`)
    }
  }
  g.__jobfinderInboxLastPoll = started
  if (shouldSavePoll(stored, saved, started)) setLastPoll(db, started)
  log(`inbox: ${found.length} searched, ${fresh.length} new, ${stored} stored from ${threads} thread(s)`)
  return { stored, threads }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The roles the conversation is about: the newest posts reaching this recruiter. */
function postsFor(db: Database.Database, email: string): ReplyRequest['posts'] {
  return db.prepare(`SELECT title, company, location, text FROM posts
    WHERE EXISTS (SELECT 1 FROM json_each(posts.emails) WHERE value = ?) ORDER BY scraped_at DESC LIMIT 5`)
    .all(email) as ReplyRequest['posts']
}

/**
 * Drafts the owner's answer to the newest reply in a thread: one claude session, one Gmail draft in the same
 * thread, and the previous app reply draft deleted only if nobody edited it (inbox-core isUnedited).
 */
export async function runReplyJob(args: { messageId?: string, note?: string }, push: (s: string) => void, signal: AbortSignal): Promise<number> {
  const config = readConfig()
  const status = gmailStatus(config.profile.email)
  if (!status.authorized || !status.email) {
    push('gmail is not connected — open Settings and press Connect Gmail')
    return 1
  }
  const self = status.email.toLowerCase()
  const { db, close } = openWritableDb()
  try {
    const asked = args.messageId ? inboxRow(db, args.messageId) : undefined
    if (!asked) {
      push(`no inbox message ${args.messageId}`)
      return 1
    }
    // always the newest stored message of the thread: a reply that arrived after this job was queued wins
    const row = latestInThread(db, asked.thread_id) ?? asked
    // read before supersedeQueued: an older queued row may hold an earlier draft, and superseded rows are
    // excluded. Includes this row's own draft on a Re-draft (it is `queued` now) — replaced below.
    const priors = priorReplyDrafts(db, row.thread_id)
    // this job covers the whole thread: an older message still `queued` would be re-enqueued by every poll
    supersedeQueued(db, row.thread_id, row.message_id)
    try {
      const thread = await gmailRead(() => gmail<{ messages?: ThreadMsg[] }>(`threads/${row.thread_id}?format=full`))
      const msgs = (thread.messages ?? []).filter(m => !m.labelIds?.includes('DRAFT'))
        .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
      const latest = msgs.find(m => m.id === row.message_id)
      if (!latest) throw new Error('the message is no longer in Gmail')
      if (ownerAnswered(msgs, self, row.message_id)) {
        markAnswered(db, row.message_id)
        push(`${row.contact_email}: you already replied in Gmail — no draft`)
        return 0
      }

      const res = await runReplyDrafter({
        recruiterEmail: row.contact_email,
        note: args.note ?? '',
        thread: msgs.map(m => ({
          from: headerOf(m, 'From'),
          date: day(Number(m.internalDate)),
          mine: !isInbound(m, self),
          body: (stripQuoted(plainBody(m.payload)) || m.snippet || '').slice(0, 4000)
        })),
        posts: postsFor(db, row.contact_email)
      }, config, { onLog: l => push(`${row.contact_email}: ${l}`), signal })

      const { to, cc } = replyRecipients(latest, self)
      const head = replyHeaders({ threadId: row.thread_id, messageId: headerOf(latest, 'Message-Id') || undefined, subject: headerOf(latest, 'Subject') })
      const sig = signature(config.profile)
      const created = await createDraft({
        to, cc: cc.join(', ') || undefined, subject: head.subject, inReplyTo: head.inReplyTo, references: head.references,
        text: `${res.body}\n\n${sig}`, html: renderHtml(res.body, sig)
      }, null, head.threadId)

      // recorded at once: from here the draft is tracked, so nothing below may mark the job failed
      recordReplyDraft(db, { messageId: row.message_id, draftId: created.id, draftMsgId: created.messageId, to, questions: res.questions, note: null })

      // the previous app reply drafts in this thread: deleted only when untouched, after the new one exists
      let kept = 0
      for (const p of priors) {
        if (p.draftId === created.id) continue
        try {
          const cur = await gmailRead(() => gmail<{ message?: { id: string } }>(`drafts/${p.draftId}?format=minimal`))
          if (isUnedited(p.draftMsgId, cur.message?.id ?? null)) {
            await gmailRead(() => gmail(`drafts/${p.draftId}`, { method: 'DELETE' }))
          } else {
            kept++
          }
        } catch (e) {
          const err = e as Error & { statusCode?: number }
          if (err.statusCode !== 404) { // 404: already sent or deleted
            push(`${row.contact_email}: could not clear earlier draft ${p.draftId}: ${err.message}`)
            continue
          }
        }
        if (p.messageId !== row.message_id) markReply(db, p.messageId, 'superseded')
      }
      if (kept) noteReply(db, row.message_id, 'your edited earlier draft was kept beside this one')
      const threaded = head.threadId && created.threadId === head.threadId
      push(`${row.contact_email}: reply draft created (${created.id}), ${threaded ? 'in the thread' : 'NEW THREAD'}${res.questions.length ? `, ${res.questions.length} question(s) for you` : ''}`)
      return 0
    } catch (e) {
      if (signal.aborted) {
        push(`${row.contact_email}: stopped`)
        markReply(db, row.message_id, 'failed', 'stopped — press Re-draft')
        return 1
      }
      markReply(db, row.message_id, 'failed', (e as Error).message.slice(0, 300))
      throw e
    }
  } finally {
    close()
  }
}
