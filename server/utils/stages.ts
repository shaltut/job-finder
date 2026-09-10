// The recruiter stage machine, as a pure function so it can be tested without Gmail.
//
// Gmail (sent mail) is the truth about what was actually sent; `contacts` only caches the stage. A draft is
// not a contact until it is sent by hand. Each address gets at most two emails, ever: the application and one
// follow-up after three days of silence. After that it is `final` and gets nothing more.
import type { Stage } from '../db/schema'

export type MessageKind = 'outgoing' | 'bounce' | 'auto-reply' | 'reply' | 'other'

export interface GmailMessage {
  id: string
  threadId: string
  from: string
  subject: string
  snippet: string
  /** epoch ms */
  date: number
}

/**
 * Order matters. An auto-reply that mentions the recruiter's domain is not a reply, and a bounce from
 * mailer-daemon is not one either — treating either as a human answer would stop a live application dead.
 */
export function classifyMessage(m: GmailMessage, selfEmail: string, recruiterEmail: string): MessageKind {
  const from = m.from.toLowerCase()
  const subject = (m.subject || '').toLowerCase()
  const snippet = (m.snippet || '').toLowerCase()

  if (selfEmail && from.includes(selfEmail.toLowerCase())) return 'outgoing'

  if (/mailer-daemon|postmaster/.test(from) || /undeliverable|delivery status|delivery failure|returned mail/.test(subject)) {
    return 'bounce'
  }
  if (/no-?reply|do-?not-?reply/.test(from)
    || /automatic reply|auto-?reply|out of office|we have received your application|thank you for applying/.test(`${subject} ${snippet}`)) {
    return 'auto-reply'
  }

  const domain = recruiterEmail.split('@')[1]?.toLowerCase()
  if (from.includes(recruiterEmail.toLowerCase()) || (domain && from.includes(`@${domain}`))) return 'reply'
  return 'other'
}

export type Action
  = | 'none'
    | 'send-the-application' // a draft is waiting in Gmail for him to send
    | 'send-the-follow-up'
    | 'draft-the-follow-up'
    | 'draft-the-application'

export interface Decision {
  /** the row of the original 8-row table this matched, for the report and the tests */
  row: number
  stage: Stage
  action: Action
  note: string
  /** what every post from this address should record in `applications` */
  postsReason: string
  /** when the follow-up becomes due, if we are waiting */
  followUpDueAt: number | null
}

export const FOLLOW_UP_AFTER_MS = 72 * 3600_000 // "three days of silence"

export interface DecideInput {
  messages: GmailMessage[]
  selfEmail: string
  recruiterEmail: string
  dbStage: Stage | null
  /** does a draft to this address still exist in Gmail? `search_threads` never returns drafts */
  hasPendingDraft: boolean
  now: number
}

/**
 * The 8-row table from the original skill, in code. Rows are tested top to bottom; the first match wins.
 */
export function decideStage(input: DecideInput): Decision {
  const { messages, selfEmail, recruiterEmail, dbStage, hasPendingDraft, now } = input
  const kinds = messages.map(m => ({ m, kind: classifyMessage(m, selfEmail, recruiterEmail) }))

  const outgoing = kinds.filter(k => k.kind === 'outgoing').map(k => k.m).sort((a, b) => a.date - b.date)
  const bounced = kinds.find(k => k.kind === 'bounce')
  const replied = kinds.filter(k => k.kind === 'reply').sort((a, b) => b.m.date - a.m.date)[0]

  // 1 — a dead address costs nothing more
  if (bounced) {
    return { row: 1, stage: 'final', action: 'none', note: 'bounced', postsReason: 'recruiter final', followUpDueAt: null }
  }

  // 2 — a human answered; he takes it from here, nothing automatic
  if (replied) {
    const when = new Date(replied.m.date).toISOString().slice(0, 10)
    return { row: 2, stage: 'replied', action: 'none', note: `replied ${when}`, postsReason: `recruiter replied ${when}`, followUpDueAt: null }
  }

  // 3 — application and follow-up both sent, still silence: the ceiling
  if (outgoing.length >= 2) {
    return { row: 3, stage: 'final', action: 'none', note: 'no reply after follow-up', postsReason: 'recruiter final', followUpDueAt: null }
  }

  if (outgoing.length === 1) {
    const last = outgoing[0]!.date
    const due = last + FOLLOW_UP_AFTER_MS

    // 4 — the follow-up is already written and waiting to be sent
    if (dbStage === 'followed_up' && hasPendingDraft) {
      return { row: 4, stage: 'followed_up', action: 'send-the-follow-up', note: 'follow-up draft pending, send it', postsReason: 'follow-up pending', followUpDueAt: due }
    }
    // 5 — sent, but three days have not passed
    if (now < due) {
      return { row: 5, stage: 'contacted', action: 'none', note: `follow-up due ${new Date(due).toISOString()}`, postsReason: 'recruiter contacted, follow-up due', followUpDueAt: due }
    }
    // 6 — three days of silence: write the one follow-up he is allowed
    return { row: 6, stage: 'followed_up', action: 'draft-the-follow-up', note: 'silent for 3 days', postsReason: 'named in follow-up', followUpDueAt: due }
  }

  // 7 — nothing sent yet, but a draft is already waiting. Never edit it.
  if (hasPendingDraft) {
    return { row: 7, stage: 'drafted', action: 'send-the-application', note: 'application draft pending, send it', postsReason: 'application draft pending', followUpDueAt: null }
  }

  // 8 — never contacted, nothing pending: screen and write
  return { row: 8, stage: dbStage ?? 'drafted', action: 'draft-the-application', note: 'not contacted yet', postsReason: 'to draft', followUpDueAt: null }
}

/** Human-readable countdown for the Pipeline view. */
export function untilDue(dueAt: number | null, now: number): string | null {
  if (!dueAt) return null
  const ms = dueAt - now
  if (ms <= 0) return 'due now'
  const h = Math.round(ms / 3600_000)
  return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`
}
