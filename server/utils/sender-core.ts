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
export function sendable(d: { subject: string, body: string, hasPdf: boolean, action: string }): { ok: true } | { ok: false, reason: string } {
  if (PLACEHOLDER.test(d.subject) || PLACEHOLDER.test(d.body)) return { ok: false, reason: 'placeholder in the draft' }
  if (!d.hasPdf) return { ok: false, reason: 'no CV attached' }
  if (d.action !== 'send-the-application' && d.action !== 'send-the-follow-up') {
    return { ok: false, reason: `no longer pending in Gmail (${d.action})` }
  }
  return { ok: true }
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
