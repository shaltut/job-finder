// The inbox: a 5-minute poll for replies in threads the owner started, and the job that drafts an answer.
// See docs/superpowers/specs/2026-10-07-inbox-replies-design.md.
import type Database from 'better-sqlite3'
import { gmail } from './gmail'
import { headerOf, isInbound, plainBody, stripQuoted, threadContact, type ThreadMsg } from './inbox-core'
import { knownIds, lastPoll, markReply, setLastPoll, storeInbound } from './inbox-store'
import { classifyMessage } from './stages'
import { gmailRead } from './sync'

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
  const since = lastPoll(db)
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
      if (newest) {
        markReply(db, newest.id, 'queued')
        threads++
        onThread({ messageId: newest.id, threadId })
      }
    } catch (e) {
      log(`inbox: thread ${threadId} skipped — ${(e as Error).message}`)
    }
  }
  setLastPoll(db, started)
  log(`inbox: ${found.length} searched, ${fresh.length} new, ${stored} stored from ${threads} thread(s)`)
  return { stored, threads }
}
