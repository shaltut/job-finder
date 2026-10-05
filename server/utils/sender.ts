// The one file in this app that can send mail (test/invariants.test.ts pins it). Started by hand from the
// Run view; every 15 minutes it sends up to 10 of the app's own pending Gmail drafts, picked at random,
// until none are left. Each draft is re-checked just before it goes (sender-core.ts sendable()).
// See docs/superpowers/specs/2026-10-05-draft-sender-design.md.
import type Database from 'better-sqlite3'
import { gmail, gmailStatus } from './gmail'
import { openWritableDb } from './ingest'
import { draftText, pickBatch, sendable, type GmailDraft } from './sender-core'
import { gmailDecision } from './sync'

const BATCH = 10
const EVERY_MS = 15 * 60_000

/** Every draft id waiting in Gmail right now — the app's and the owner's alike; app_drafts tells them apart. */
async function gmailDraftIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  let page: string | undefined
  do {
    const r = await gmail<{ drafts?: { id: string }[], nextPageToken?: string }>(
      `drafts?maxResults=500&fields=drafts/id,nextPageToken${page ? `&pageToken=${page}` : ''}`
    )
    for (const d of r.drafts ?? []) ids.add(d.id)
    page = r.nextPageToken
  } while (page)
  return ids
}

const mark = (db: Database.Database, id: string, outcome: string) =>
  db.prepare('UPDATE app_drafts SET outcome = ? WHERE draft_id = ?').run(outcome, id)

/** One round: settle what is gone, then send up to BATCH of what is still waiting. Returns drafts still pending. */
async function round(db: Database.Database, selfEmail: string, push: (s: string) => void, signal: AbortSignal): Promise<number> {
  const unsent = db.prepare('SELECT draft_id, email FROM app_drafts WHERE sent_at IS NULL AND outcome IS NULL')
    .all() as { draft_id: string, email: string }[]
  const waiting = await gmailDraftIds()
  const gone = unsent.filter(r => !waiting.has(r.draft_id))
  for (const r of gone) mark(db, r.draft_id, 'gone') // sent or deleted by hand, before the lane saw it
  if (gone.length) push(`${gone.length} app draft(s) no longer in Gmail — sent or deleted by hand`)
  const live = unsent.filter(r => waiting.has(r.draft_id))
  if (!live.length) return 0

  const batch = pickBatch(live.map(r => r.draft_id), BATCH)
  push(`sending ${batch.length} of ${live.length} pending draft(s)`)
  for (const id of batch) {
    if (signal.aborted) break
    const row = live.find(r => r.draft_id === id)!
    try {
      const t = draftText(await gmail<GmailDraft>(`drafts/${id}?format=full`))
      const to = t.to || row.email
      const decision = await gmailDecision(db, to, selfEmail)
      const verdict = sendable({ subject: t.subject, body: t.body, hasPdf: t.hasPdf, action: decision.action })
      if (!verdict.ok) {
        mark(db, id, verdict.reason)
        push(`${to}: not sent — ${verdict.reason}`)
        continue
      }
      await gmail(`drafts/send`, { method: 'POST', body: JSON.stringify({ id }) })
      db.prepare('UPDATE app_drafts SET sent_at = unixepoch() WHERE draft_id = ?').run(id)
      push(`${to}: sent — ${t.subject}`)
    } catch (e) {
      // a 404 between the listing and now: gone; anything else stays pending for the next round
      const err = e as Error & { statusCode?: number }
      if (err.statusCode === 404) mark(db, id, 'gone')
      push(`${row.email}: ${err.statusCode === 404 ? 'gone' : `failed, retried next round — ${err.message}`}`)
    }
  }
  // counted, not computed: a send that failed (not a 404) stays pending and must keep the lane going
  return (db.prepare('SELECT count(*) n FROM app_drafts WHERE sent_at IS NULL AND outcome IS NULL').get() as { n: number }).n
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => {
    clearTimeout(t)
    resolve()
  }, { once: true })
})

/** The lane's job. `afterRound` queues the Gmail sync, so stages and follow-up clocks move with each batch. */
export async function runSendJob(push: (s: string) => void, signal: AbortSignal, afterRound: () => void): Promise<number> {
  const status = gmailStatus()
  if (!status.authorized || !status.email) {
    push('gmail is not connected — nothing can be sent')
    return 1
  }
  const { db, close } = openWritableDb()
  try {
    for (;;) {
      const left = await round(db, status.email, push, signal)
      afterRound()
      if (signal.aborted) {
        push('stopped')
        return 1
      }
      if (left === 0) {
        push('all app drafts sent — nothing left to send')
        return 0
      }
      push(`${left} still waiting — next batch in 15 minutes`)
      await sleep(EVERY_MS, signal)
      if (signal.aborted) {
        push('stopped')
        return 1
      }
    }
  } finally {
    close()
  }
}
