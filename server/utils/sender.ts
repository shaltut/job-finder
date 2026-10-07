// The one file in this app that can send mail (test/invariants.test.ts pins it). Started by hand from the
// Run view; every 15 minutes it sends up to 10 of the app's own pending Gmail drafts, picked at random,
// until none are left. Each draft is re-checked just before it goes (sender-core.ts sendable()).
// See docs/superpowers/specs/2026-10-05-draft-sender-design.md.
import type Database from 'better-sqlite3'
import { gmail, gmailStatus } from './gmail'
import { openWritableDb } from './ingest'
import { backoff } from './queue-core'
import { draftText, modeOf, pickBatch, sendable, type GmailDraft } from './sender-core'
import { gmailDecision } from './sync'

const BATCH = 10
const EVERY_MS = 15 * 60_000

/** Every draft id waiting in Gmail right now — the app's and the owner's alike; app_drafts tells them apart. */
async function gmailDraftIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  let page: string | undefined
  do {
    const r = await backoff(() => gmail<{ drafts?: { id: string }[], nextPageToken?: string }>(
      `drafts?maxResults=500&fields=drafts/id,nextPageToken${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`
    ))
    for (const d of r.drafts ?? []) ids.add(d.id)
    page = r.nextPageToken
  } while (page)
  return ids
}

const mark = (db: Database.Database, id: string, outcome: string) =>
  db.prepare('UPDATE app_drafts SET outcome = ? WHERE draft_id = ?').run(outcome, id)

/** One round: settle what is gone, then send up to BATCH of what is still waiting. Returns drafts still pending. */
async function round(
  db: Database.Database, selfEmail: string, push: (s: string) => void, signal: AbortSignal, failures: Map<string, number>
): Promise<number> {
  const waiting = await gmailDraftIds()
  // Adopt drafts to recruiters the app knows. Follow-ups drafted before app_drafts existed were never recorded
  // (their id lived in a note the sweep overwrites), so they were invisible here (owner, 2026-10-05). Only an
  // address in `contacts` qualifies; the stage check below still decides whether anything goes out.
  const known = new Set((db.prepare('SELECT draft_id FROM app_drafts').all() as { draft_id: string }[]).map(r => r.draft_id))
  const recruiters = new Set((db.prepare('SELECT email FROM contacts').all() as { email: string }[]).map(r => r.email))
  let adopted = 0
  for (const id of waiting) {
    if (known.has(id) || signal.aborted) continue
    const to = draftText(await backoff(() => gmail<GmailDraft>(`drafts/${id}?format=metadata&metadataHeaders=To`))).to
    if (!recruiters.has(to)) continue
    db.prepare(`INSERT OR IGNORE INTO app_drafts (draft_id, email, mode, created_at) VALUES (?, ?, 'apply', unixepoch())`).run(id, to)
    adopted++
  }
  if (adopted) push(`${adopted} draft(s) to known recruiters adopted (drafted before the sender kept a record)`)

  const unsent = db.prepare(`SELECT draft_id, email, mode FROM app_drafts WHERE sent_at IS NULL AND outcome IS NULL AND mode <> 'reply'`)
    .all() as { draft_id: string, email: string, mode: string }[]
  const gone = unsent.filter(r => !waiting.has(r.draft_id))
  for (const r of gone) mark(db, r.draft_id, 'gone') // sent or deleted by hand, before the lane saw it
  if (gone.length) push(`${gone.length} app draft(s) no longer in Gmail — sent or deleted by hand`)
  const live = unsent.filter(r => waiting.has(r.draft_id))
  if (!live.length) return 0

  const batch = pickBatch(live.map(r => r.draft_id), BATCH)
  push(`sending ${batch.length} of ${live.length} pending draft(s)`)
  const sentThisRound = new Set<string>()
  for (const id of batch) {
    if (signal.aborted) break
    const row = live.find(r => r.draft_id === id)!
    try {
      const draft = await backoff(() => gmail<GmailDraft>(`drafts/${id}?format=full`))
      const t = draftText(draft)
      const to = t.to || row.email
      // what this draft is, from its own thread — not the stored label (sender-core modeOf)
      const thread = draft.message.threadId
        ? await backoff(() => gmail<{ messages?: { labelIds?: string[] }[] }>(`threads/${draft.message.threadId}?format=minimal&fields=messages/labelIds`))
        : { messages: [] }
      const mode = modeOf(thread.messages ?? [])
      if (mode !== row.mode) db.prepare(`UPDATE app_drafts SET mode = ? WHERE draft_id = ? AND mode <> 'reply'`).run(mode, id)
      const decision = await gmailDecision(db, to, selfEmail)
      // a reply job may have recorded this draft as a reply since the list was read: never send it
      if ((db.prepare('SELECT mode FROM app_drafts WHERE draft_id = ?').get(id) as { mode?: string } | undefined)?.mode === 'reply') continue
      const verdict = sendable({
        subject: t.subject,
        body: t.body,
        hasPdf: t.hasPdf,
        action: decision.action,
        mode,
        recipientMatches: t.to === row.email,
        // a local record, because Gmail's search can lag a send by minutes
        sentBefore: !!db.prepare('SELECT 1 FROM app_drafts WHERE email = ? AND mode = ? AND sent_at IS NOT NULL').get(row.email, mode),
        sentThisRound: sentThisRound.has(row.email),
        stage: (db.prepare('SELECT stage FROM contacts WHERE email = ?').get(row.email) as { stage?: string } | undefined)?.stage ?? null
      })
      if (!verdict.ok) {
        mark(db, id, verdict.reason)
        push(`${to}: not sent — ${verdict.reason}`)
        continue
      }
      // Stop pressed during the checks above: nothing goes out after it
      if (signal.aborted) break
      await backoff(() => gmail(`drafts/send`, { method: 'POST', body: JSON.stringify({ id }) }))
      sentThisRound.add(row.email)
      db.prepare('UPDATE app_drafts SET sent_at = unixepoch() WHERE draft_id = ?').run(id)
      push(`${to}: sent — ${t.subject}`)
    } catch (e) {
      const err = e as Error & { statusCode?: number }
      const code = err.statusCode ?? 0
      const tries = (failures.get(id) ?? 0) + 1
      failures.set(id, tries)
      // gone between the listing and now; or a refusal that will not change (bad recipient, malformed draft,
      // forbidden); or a draft that keeps failing — set aside with the reason, so the lane can finish
      const outcome = code === 404
        ? 'gone'
        : (code >= 400 && code < 500 && code !== 429)
            ? `failed: ${err.message.slice(0, 120)}`
            : tries >= 3 ? `failed ${tries} times: ${err.message.slice(0, 100)}` : null
      if (outcome) mark(db, id, outcome)
      push(`${row.email}: ${outcome ?? `failed, retried next round — ${err.message}`}`)
    }
  }
  // counted, not computed: a send that failed (not a 404) stays pending and must keep the lane going
  return (db.prepare(`SELECT count(*) n FROM app_drafts WHERE sent_at IS NULL AND outcome IS NULL AND mode <> 'reply'`).get() as { n: number }).n
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
  const failures = new Map<string, number>() // per draft, this job: three transient failures set it aside
  // Held only because a stored label said 'application' — the mode is now read from Gmail, so look again
  // Also every stage-based hold: until 2026-10-05 drafts were counted as sent mail (stages.ts sentMail), so
  // "no longer pending" and "application already went out" could be the bug, not the recruiter
  const relooked = db.prepare(`UPDATE app_drafts SET outcome = NULL WHERE sent_at IS NULL
    AND (outcome LIKE 'an application already went out%' OR outcome LIKE 'no longer pending in Gmail%')`).run().changes
  if (relooked) push(`${relooked} draft(s) held as a second application are checked again, their kind now read from Gmail`)
  try {
    for (;;) {
      const left = await round(db, status.email, push, signal, failures)
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
