// The stage sweep: re-check every open recruiter against Gmail and move their stage.
//
// A recruiter's stage changes without any new post appearing — he sends the draft, the recruiter replies,
// three days pass. So this runs at the start of every drafter run, from the Pipeline view's button, and once
// a day on a schedule, whether or not the address has a post in the batch.
import type Database from 'better-sqlite3'
import type { AppConfig } from './config'
import { runDrafter, type DraftPost } from './drafter'
import { persist, signature } from './drafts'
import { createDraft, gmail, renderHtml } from './gmail'
import { decideStage, untilDue, type Decision, type GmailMessage } from './stages'

interface RawMessage {
  id: string
  threadId: string
  snippet?: string
  internalDate?: string
  payload?: { headers?: { name: string, value: string }[] }
}

const header = (m: RawMessage, name: string) =>
  m.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''

/** Every message either side of this address. Sent mail is included; drafts are not, which is the point. */
async function threadMessages(email: string): Promise<GmailMessage[]> {
  const q = `to:${email} OR from:${email} OR "${email}"`
  const list = await gmail<{ messages?: { id: string }[] }>(`messages?q=${encodeURIComponent(q)}&maxResults=50`)
  const out: GmailMessage[] = []
  for (const { id } of list.messages ?? []) {
    const m = await gmail<RawMessage>(
      `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
    )
    out.push({
      id: m.id,
      threadId: m.threadId,
      from: header(m, 'From'),
      subject: header(m, 'Subject'),
      snippet: m.snippet || '',
      date: Number(m.internalDate) || Date.parse(header(m, 'Date')) || 0
    })
  }
  return out
}

/** `messages` never returns drafts, even with `in:draft` — trusting it once nearly produced a duplicate. */
async function hasPendingDraft(email: string): Promise<boolean> {
  const r = await gmail<{ drafts?: unknown[] }>(`drafts?q=${encodeURIComponent(`to:${email}`)}&maxResults=5`)
  return !!r.drafts?.length
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
  onLog: (s: string) => void = () => {}
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

  for (const c of open) {
    const messages = await threadMessages(c.email)
    const pending = await hasPendingDraft(c.email)
    const d = decideStage({
      messages, selfEmail, recruiterEmail: c.email, dbStage: c.stage, hasPendingDraft: pending, now
    })

    // 'final' is never reset — the WHERE clause enforces that, not this code
    db.prepare(`
      UPDATE contacts SET stage = @stage, note = @note, last_sent_at = @lastSent, updated_at = @now
      WHERE email = @email AND stage <> 'final'
    `).run({
      email: c.email,
      stage: d.stage,
      note: d.note,
      lastSent: d.followUpDueAt ? Math.floor((d.followUpDueAt - 72 * 3600e3) / 1000) : null,
      now: Math.floor(now / 1000)
    })

    if (d.action === 'draft-the-follow-up') {
      await draftFollowUp(db, config, c.email, onLog)
    }

    const line: SweepLine = {
      email: c.email,
      row: d.row,
      from: c.stage,
      to: d.stage,
      action: d.action,
      note: d.note,
      due: untilDue(d.followUpDueAt, now)
    }
    lines.push(line)
    onLog(`${c.email}: ${c.stage} -> ${d.stage} (row ${d.row}, ${d.action})${line.due ? `, follow-up ${line.due}` : ''}`)
  }
  return lines
}

/**
 * The follow-up names every post from this address that no sent email has mentioned yet — that is what the
 * `named in ...` prefix on `applications.reason` is for.
 */
async function draftFollowUp(db: Database.Database, config: AppConfig, email: string, onLog: (s: string) => void) {
  const rows = db.prepare(`
    SELECT p.* FROM posts p LEFT JOIN applications a ON a.key = p.key
    WHERE EXISTS (SELECT 1 FROM json_each(p.emails) WHERE value = ?)
      AND (a.key IS NULL OR a.reason NOT LIKE 'named in %')
  `).all(email) as Record<string, unknown>[]

  const posts: DraftPost[] = rows.map(r => ({
    key: r.key as string,
    title: r.title as string | null,
    company: r.company as string | null,
    location: r.location as string | null,
    score: r.score as number | null,
    flags: JSON.parse((r.flags as string) || '[]'),
    text: r.text as string
  }))

  if (!posts.length) {
    onLog(`${email}: follow-up due but no unnamed posts to carry it — leaving it to you`)
    return
  }

  const req = { mode: 'follow-up' as const, recruiterEmail: email, posts }
  const res = await runDrafter(req, config, { onLog })
  const carrier = res.results.find(r => r.body)
  if (!carrier?.body) {
    onLog(`${email}: the drafter returned no follow-up body`)
    return
  }

  const sig = signature(config.profile)
  const created = await createDraft(
    { to: email, subject: carrier.subject, text: `${carrier.body}\n\n${sig}`, html: renderHtml(carrier.body, sig) },
    config.cv
  )
  persist(db, req, res, created.id)
  onLog(`${email}: follow-up draft created (${created.id})${created.attachedBytes ? `, CV ${created.attachedBytes} bytes` : ''}`)
}
