// The draft sender's decisions, pure, so test/sender.test.ts can pin every refusal. The sending itself is
// server/utils/sender.ts — the one file allowed to send (test/invariants.test.ts).
// See docs/superpowers/specs/2026-10-05-draft-sender-design.md.
import { PLACEHOLDER } from './drafter.ts'

interface Part { mimeType?: string, filename?: string, headers?: { name: string, value: string }[], body?: { data?: string }, parts?: Part[] }
export interface GmailDraft { id: string, message: { id: string, threadId?: string, payload?: Part } }

const flatten = (p: Part | undefined): Part[] => (p ? [p, ...(p.parts ?? []).flatMap(flatten)] : [])

/** What the sender needs from a draft: who it goes to, what it says, and whether the CV is attached. */
export function draftText(d: GmailDraft): { to: string, subject: string, body: string, hasPdf: boolean } {
  const payload = d.message.payload
  const header = (name: string) => payload?.headers?.find(h => h.name.toLowerCase() === name)?.value ?? ''
  const to = header('to')
  const angle = to.match(/<([^>]+)>/)
  const parts = flatten(payload)
  const plain = parts.find(p => p.mimeType === 'text/plain' && p.body?.data)
  return {
    to: (angle?.[1] ?? to.split(',')[0] ?? '').trim().toLowerCase(),
    subject: header('subject'),
    body: plain ? Buffer.from(plain.body!.data!, 'base64url').toString('utf8') : '',
    hasPdf: parts.some(p => p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.filename ?? ''))
  }
}

/**
 * The last word before a send. The owner chose no review step, so this is the backstop: a hole in the
 * text, a missing CV, or a recruiter whose Gmail no longer reads "a draft of ours is pending" — rows 7 and 4
 * of the stage machine. A reply, a bounce or an email already sent since the draft was written is anything
 * else, and the draft stays where it is.
 */
export interface SendCheck {
  subject: string
  body: string
  hasPdf: boolean
  /** decideStage() over the recruiter's real mail, now */
  action: string
  /** what the app drafted it as: an application or a follow-up */
  mode: string
  /** the draft's To is still the address the app drafted it for */
  recipientMatches: boolean
  /** app_drafts already records a sent draft of this mode to this address */
  sentBefore: boolean
  /** this round already sent to this address */
  sentThisRound: boolean
  /** the recruiter's cached contacts.stage: `replied` may be a colleague's reply Gmail's decision cannot see */
  stage?: string | null
}

/**
 * The stage check alone is not enough (review 2026-10-05): the draft being checked is itself a pending draft,
 * so "row 7 or row 4" only meant "fewer than two emails out" — an application draft would pass row 4 once
 * any email had gone, i.e. a second application. So the mode must match the stage, and a local record —
 * which does not wait for Gmail's search index to catch up with a send — refuses a second of the same kind.
 */
export function sendable(d: SendCheck): { ok: true } | { ok: false, reason: string } {
  if (!d.recipientMatches) return { ok: false, reason: 'recipient changed in Gmail — send it yourself if intended' }
  if (!d.body.trim()) return { ok: false, reason: 'empty body (or unreadable) — nothing to check' }
  if (PLACEHOLDER.test(d.subject) || PLACEHOLDER.test(d.body)) return { ok: false, reason: 'placeholder in the draft' }
  if (!d.hasPdf) return { ok: false, reason: 'no CV attached' }
  if (d.stage === 'replied') return { ok: false, reason: 'the recruiter has replied — answer from the Inbox' }
  if (d.sentThisRound) return { ok: false, reason: 'already sent to this address this round' }
  if (d.sentBefore) return { ok: false, reason: `already sent a ${d.mode} to this address` }
  if (d.mode === 'apply' && d.action === 'send-the-follow-up') {
    return { ok: false, reason: 'an application already went out to this address — this would be a second one' }
  }
  if (d.mode === 'follow-up' && d.action === 'send-the-application') {
    return { ok: false, reason: 'a follow-up, but no application was sent before it' }
  }
  const want = d.mode === 'follow-up' ? 'send-the-follow-up' : 'send-the-application'
  if (d.action !== want) return { ok: false, reason: `no longer pending in Gmail (${d.action})` }
  return { ok: true }
}

/**
 * What a draft is, read from Gmail rather than from a stored label: a draft inside a thread where we already
 * sent something is a follow-up; anything else is an application. The backfill could only guess (44 follow-ups
 * came in labelled as applications), and follow-ups drafted before app_drafts existed had no label at all.
 */
export function modeOf(threadMessages: { labelIds?: string[] }[]): 'apply' | 'follow-up' {
  return threadMessages.some(m => m.labelIds?.includes('SENT') && !m.labelIds.includes('DRAFT')) ? 'follow-up' : 'apply'
}

/** Up to n ids in random order (Fisher-Yates over a copy). */
export function pickBatch(ids: string[], n: number, random: () => number = Math.random): string[] {
  const a = [...ids]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a.slice(0, n)
}
