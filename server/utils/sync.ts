// The stage sweep: re-check every open recruiter against Gmail and move their stage.
//
// A recruiter's stage changes without any new post appearing — he sends the draft, the recruiter replies,
// three days pass. So it runs from the Pipeline view's button and once a day on a schedule, whether or not
// the address has a post in the batch. It is NOT run by a drafter run: that asks Gmail per recruiter
// instead, through closedInGmail() below, because the sweep only iterates addresses `contacts` already
// knows and a recruiter written to outside this app has no row there at all.
import type Database from 'better-sqlite3'
import type { AppConfig } from './config'
import { followUpAttachment } from './cv-attach'
import { runDrafter } from './drafter'
import { persist, signature } from './drafts'
import { ccFrom, createDraft, gmail, renderHtml, replyHeaders } from './gmail'
import { cachedStage, closedBy, decideStage, untilDue, type Decision, type GmailMessage } from './stages'
import { followUpPosts, healContact } from './contacts'
import { backoff, concurrency, limiter, pool } from './queue-core'

interface RawMessage {
  id: string
  threadId: string
  snippet?: string
  internalDate?: string
  payload?: { headers?: { name: string, value: string }[] }
}

const header = (m: RawMessage, name: string) =>
  m.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''

/**
 * Every Gmail read in this file goes through one limiter: the sweep reads several recruiters at once and
 * the draft gate runs beside parallel drafting. Gmail allows 15,000 quota units per minute per user and a
 * read costs 5, so ~50 reads/s at most. A cap of 6 in flight alone was not a rate — fast replies ran it far
 * past that and the first parallel sync died on "Quota exceeded" (2026-10-04) — so calls also start 30 ms
 * apart (~33/s, ~165 units/s, room for createDraft beside it), and a rate-limit refusal waits and retries.
 */
const paced = limiter(6, 30)
const gmailRead = <T>(fn: () => Promise<T>) => backoff(() => paced(fn))

/** Every message either side of this address. Sent mail is included; drafts are not, which is the point. */
async function threadMessages(email: string): Promise<GmailMessage[]> {
  const q = `to:${email} OR from:${email} OR "${email}"`
  const list = await gmailRead(() => gmail<{ messages?: { id: string }[] }>(`messages?q=${encodeURIComponent(q)}&maxResults=50`))
  // the reads in parallel, the order kept — decideStage() is handed the list exactly as search returned it
  const raw = await Promise.all((list.messages ?? []).map(({ id }) => gmailRead(() => gmail<RawMessage>(
    `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-Id`
  ))))
  return raw.map(m => ({
    id: m.id,
    threadId: m.threadId,
    messageId: header(m, 'Message-Id') || undefined,
    from: header(m, 'From'),
    subject: header(m, 'Subject'),
    snippet: m.snippet || '',
    date: Number(m.internalDate) || Date.parse(header(m, 'Date')) || 0
  }))
}

/** `messages` never returns drafts, even with `in:draft` — trusting it once nearly produced a duplicate. */
async function hasPendingDraft(email: string): Promise<boolean> {
  const r = await gmailRead(() => gmail<{ drafts?: unknown[] }>(`drafts?q=${encodeURIComponent(`to:${email}`)}&maxResults=5`))
  return !!r.drafts?.length
}

/**
 * isClosed() asked of Gmail rather than of the contacts cache, for the one question a draft run turns on:
 * may this recruiter be sent an application right now?
 *
 * The cache is only ever as fresh as the last sweep, and two of the ways it goes stale cost something: a
 * recruiter who has replied still reads `contacted`, so a new post earns them a second email in the middle
 * of a conversation; and a recruiter written to outside this app has no row at all, so they read as a
 * stranger. Gmail knows both. Rows 4 and 7 are both "a draft is waiting", and the sent count tells them
 * apart: one outgoing message means the pending draft is a follow-up, none means it is the application.
 * `dbStage` only colours row 8's stage, and row 8 is the open door, so nothing here depends on it.
 */
export async function closedInGmail(
  db: Database.Database, email: string, selfEmail: string, now = Date.now()
): Promise<false | string> {
  const cached = db.prepare('SELECT stage FROM contacts WHERE email = ?')
    .get(email.toLowerCase()) as { stage: Decision['stage'] } | undefined
  const d = decideStage({
    messages: await threadMessages(email),
    selfEmail,
    recruiterEmail: email,
    dbStage: cached?.stage ?? null,
    hasPendingDraft: await hasPendingDraft(email),
    now
  })
  const closed = closedBy(d)
  // Gmail is the only state two machines running this app share, and this is the one moment either of
  // them asks about an address it has never seen — the sweep cannot, because it only revisits addresses
  // `contacts` already holds. So keep the verdict instead of discarding it with the rest of the Decision.
  //
  // Only when closed. Row 8 is the open one and it means nothing has ever been written to this address;
  // `contacts` is the record of recruiters written to, and a row there for a stranger would put them in
  // the Pipeline view and into the next sweep's Gmail calls.
  if (closed) healContact(db, email, d, now)
  return closed
}

/**
 * The stage machine's full verdict for one address, from its real mail — for the sender, which may send a
 * draft only while this still reads "draft pending" (rows 4 and 7).
 */
export async function gmailDecision(db: Database.Database, email: string, selfEmail: string, now = Date.now()): Promise<Decision> {
  const cached = db.prepare('SELECT stage FROM contacts WHERE email = ?')
    .get(email.toLowerCase()) as { stage: Decision['stage'] } | undefined
  const [messages, pending] = await Promise.all([threadMessages(email), hasPendingDraft(email)])
  return decideStage({ messages, selfEmail, recruiterEmail: email, dbStage: cached?.stage ?? null, hasPendingDraft: pending, now })
}

export interface SweepLine {
  email: string
  row: number
  from: string | null
  to: string
  action: string
  note: string
  due: string | null
}

export async function sweep(
  db: Database.Database,
  config: AppConfig,
  selfEmail: string,
  onLog: (s: string) => void = () => {},
  // Stop. It used to reach nothing: jobs.ts made the controller and never passed it, so Stop reported
  // success while the sweep ran on — now an Opus session per due recruiter, holding the draft lane.
  signal?: AbortSignal
): Promise<SweepLine[]> {
  const open = db.prepare(
    `SELECT email, stage FROM contacts WHERE stage IN ('drafted','contacted','followed_up')`
  ).all() as { email: string, stage: Decision['stage'] }[]

  if (!open.length) {
    onLog('no open recruiters to sweep')
    return []
  }
  onLog(`sweeping ${open.length} open recruiter(s)`)

  const now = Date.now()
  const lines: SweepLine[] = []

  // Two phases. Reading and deciding is Gmail reads only, so several recruiters run at once (the limiter
  // above caps the calls). The follow-up drafts are Opus sessions and run JOBFINDER_DRAFT_CONCURRENCY at a
  // time, like drafting. Each recruiter is independent in both: its own reads, its own contacts row.
  const decided = new Map<string, Decision>()
  await pool(open, 4, async (c) => {
    const [messages, pending] = await Promise.all([threadMessages(c.email), hasPendingDraft(c.email)])
    const d = decideStage({
      messages, selfEmail, recruiterEmail: c.email, dbStage: c.stage, hasPendingDraft: pending, now
    })

    // 'final' is never reset — the WHERE clause enforces that, not this code. cachedStage(), not d.stage:
    // row 6 becomes `followed_up` only when draftFollowUp() below actually creates the draft.
    const cached = cachedStage(d)
    db.prepare(`
      UPDATE contacts SET stage = @stage, note = @note, last_sent_at = @lastSent, updated_at = @now
      WHERE email = @email AND stage <> 'final'
    `).run({
      email: c.email,
      stage: cached.stage,
      note: cached.note,
      lastSent: d.followUpDueAt ? Math.floor((d.followUpDueAt - 72 * 3600e3) / 1000) : null,
      now: Math.floor(now / 1000)
    })
    decided.set(c.email, d)
  }, signal)

  const due = open.filter(c => decided.get(c.email)?.action === 'draft-the-follow-up')
  await pool(due, concurrency(process.env.JOBFINDER_DRAFT_CONCURRENCY), async (c) => {
    // Per recruiter, like the batch drafter in jobs.ts: one Gmail rejection must not cost every recruiter
    // still queued behind it. The contact stays `contacted` above; persist() promotes it to followed_up
    // only if a draft is actually created here.
    try {
      await draftFollowUp(db, config, c.email, onLog, decided.get(c.email)!.replyTo, signal)
    } catch (e) {
      // Stop kills the claude session, which surfaces here as an exit code — not a failure worth a note
      if (signal?.aborted) {
        onLog(`${c.email}: stopped`)
      } else {
        onLog(`${c.email}: follow-up draft failed — ${(e as Error).message}`)
        noteOn(db, c.email, `follow-up draft failed, retried next sweep: ${(e as Error).message.slice(0, 160)}`)
      }
    }
  }, signal)
  if (signal?.aborted) onLog('stopped')

  for (const c of open) {
    const d = decided.get(c.email)
    if (!d) continue // not reached before Stop
    const cached = cachedStage(d)
    // read back, not `cached`: a follow-up drafted above has just moved it to followed_up in persist()
    const stageNow = (db.prepare('SELECT stage FROM contacts WHERE email = ?').get(c.email) as { stage: Decision['stage'] } | undefined)?.stage ?? cached.stage
    const line: SweepLine = {
      email: c.email,
      row: d.row,
      from: c.stage,
      to: stageNow,
      action: d.action,
      note: d.note,
      due: untilDue(d.followUpDueAt, now)
    }
    lines.push(line)
    onLog(`${c.email}: ${c.stage} -> ${stageNow} (row ${d.row}, ${d.action})${line.due ? `, follow-up ${line.due}` : ''}`)
  }
  return lines
}

/** The Pipeline shows `contacts.note`, so a follow-up that was not written says why there. */
const noteOn = (db: Database.Database, email: string, note: string) =>
  db.prepare(`UPDATE contacts SET note = ? WHERE email = ? AND stage <> 'final'`).run(note, email.toLowerCase())

/**
 * The follow-up is about the roles the application named, and names any role from this address that no
 * sent email has mentioned yet — followUpPosts() in contacts.ts chooses both, and says why dismissed and
 * hand-applied posts stay out.
 */
async function draftFollowUp(
  db: Database.Database, config: AppConfig, email: string, onLog: (s: string) => void, replyTo?: GmailMessage,
  signal?: AbortSignal
) {
  // Row 6 is reached precisely because exactly one outgoing message was found, so it always carries one.
  // If it ever does not, the honest outcome is no draft: a follow-up that cannot name the thread it is
  // following up on is the "Follow up" email this whole path exists to stop sending.
  if (!replyTo) {
    onLog(`${email}: follow-up due but the original email is not in Gmail — leaving it to you`)
    return
  }
  const posts = followUpPosts(db, email, replyTo.date)
  if (!posts.length) {
    // Every role the application named was dismissed or applied to by hand. That is the owner's call, but
    // it used to be visible only in the job log while the Pipeline read "follow-up due now" forever.
    onLog(`${email}: follow-up due but no live post to carry it — leaving it to you`)
    noteOn(db, email, 'no follow-up drafted: its roles were dismissed or applied to by hand — write one yourself if you want it')
    return
  }

  const req = {
    mode: 'follow-up' as const,
    recruiterEmail: email,
    posts,
    // the owner's local day, not UTC: a 01:30 send in UTC+3 is the previous day in UTC, and the follow-up
    // would cite that date directly above the quoted original showing the real one
    originalSentAt: new Date(replyTo.date).toLocaleDateString('sv-SE')
  }
  // prefixed: follow-ups now draft in parallel, and an unprefixed claude line cannot be attributed
  const res = await runDrafter(req, config, { onLog: line => onLog(`${email}: ${line}`), signal })
  const carrier = res.results.find(r => r.body)
  if (!carrier?.body) {
    // the why is in each skipped result's reason; without it this line reads like a failure
    const why = res.results.map(r => `${r.key.slice(0, 8)} ${r.verdict}: ${r.reason}`).join('; ')
    onLog(`${email}: the drafter returned no follow-up body${why ? ` — ${why}` : ''}`)
    return
  }

  const sig = signature(config.profile)
  // The same Cc the first email carried, and deliberately NOT computed from `posts`: followUpPosts() leaves
  // out dismissed, hand-applied and excluded posts and roles of an application that never went out, and
  // the post that carried the second address can be any of those — so this asks the whole question
  // instead: every post reaching this recruiter, named or not. `email` came from
  // `contacts` and both queries match json_each at ANY index, so the contact is not necessarily emails[0]
  // — ccFrom() excludes it by value, not position.
  const reachable = db.prepare(
    'SELECT p.emails FROM posts p WHERE EXISTS (SELECT 1 FROM json_each(p.emails) WHERE value = ?)'
  ).all(email) as { emails: string }[]
  const cc = ccFrom(reachable.map(r => JSON.parse(r.emails || '[]') as string[]), email, config.profile.email)
  // The subject, In-Reply-To and References all come from the application itself — never from the model,
  // which returns one anyway. replyHeaders() explains why Gmail insists on all three.
  const head = replyHeaders(replyTo)
  // The CV the application carried, while tailoring is on. Switching tailoring off is the rollback lever,
  // so it returns follow-ups to the uploaded PDF too, not only new applications.
  const sentCv = (db.prepare('SELECT cv_path FROM contacts WHERE email = ?')
    .get(email.toLowerCase()) as { cv_path: string | null } | undefined)?.cv_path ?? null
  const attachPath = config.tailorCv ? followUpAttachment(sentCv, config.cv) : config.cv
  const created = await createDraft(
    {
      to: email,
      cc: cc.join(', ') || undefined,
      subject: head.subject,
      inReplyTo: head.inReplyTo,
      references: head.references,
      text: `${carrier.body}\n\n${sig}`,
      html: renderHtml(carrier.body, sig)
    },
    attachPath,
    head.threadId
  )
  persist(db, req, res, created.id)
  // Verified rather than assumed, like the attached byte count: Gmail quietly gives a draft a thread of
  // its own if it dislikes any of the three criteria, and reports nothing.
  const threaded = head.threadId && created.threadId === head.threadId
  onLog(`${email}: follow-up draft created (${created.id}), ${threaded ? 'replying in the application thread' : 'NEW THREAD'}${created.attachedBytes ? `, CV ${created.attachedBytes} bytes` : ''}`)
}
