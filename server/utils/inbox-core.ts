// The inbox's pure decisions: which threads are ours, what a message says, who a reply goes to. No Gmail
// and no database, so test/inbox.test.ts imports it directly.
// See docs/superpowers/specs/2026-10-07-inbox-replies-design.md.

export interface Part { mimeType?: string, body?: { data?: string }, parts?: Part[], headers?: { name: string, value: string }[] }
export interface ThreadMsg { id: string, threadId: string, labelIds?: string[], internalDate?: string, snippet?: string, payload?: Part }

export const headerOf = (m: { payload?: Part }, name: string): string =>
  m.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''

const ADDR = /[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]+/g
export const addresses = (h: string): string[] => [...new Set((h.match(ADDR) ?? []).map(a => a.toLowerCase()))]

const fromSelf = (m: ThreadMsg, self: string) => addresses(headerOf(m, 'From')).includes(self.toLowerCase())

/**
 * The recruiter a thread was started with: the earliest SENT message from the owner addressed to a known
 * contact. null means the thread is not one the owner started with a recruiter, and is not inbox material.
 */
export function threadContact(messages: ThreadMsg[], selfEmail: string, contacts: Set<string>): string | null {
  const sent = messages
    .filter(m => m.labelIds?.includes('SENT') && !m.labelIds.includes('DRAFT') && fromSelf(m, selfEmail))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
  for (const m of sent) {
    for (const a of addresses(headerOf(m, 'To'))) if (contacts.has(a)) return a
  }
  return null
}

export const isInbound = (m: ThreadMsg, selfEmail: string): boolean =>
  !m.labelIds?.includes('SENT') && !m.labelIds?.includes('DRAFT') && !fromSelf(m, selfEmail)

const decode = (d?: string) => (d ? Buffer.from(d, 'base64url').toString('utf8') : '')
const findPart = (p: Part, type: string): Part | undefined =>
  p.mimeType === type && p.body?.data ? p : p.parts?.map(c => findPart(c, type)).find(Boolean)
const htmlText = (h: string) => h
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
  .replace(/&amp;/g, '&')

/** The message's text: its text/plain part, else its HTML with the tags stripped. */
export function plainBody(p?: Part): string {
  if (!p) return ''
  const text = findPart(p, 'text/plain')
  if (text) return decode(text.body!.data)
  const html = findPart(p, 'text/html')
  return html ? htmlText(decode(html.body!.data)) : ''
}

// Where the quoted history starts. Bounded so an ordinary sentence starting "On" cannot swallow a reply.
const QUOTE_START = [
  /^On [\s\S]{0,300}?wrote:[ \t]*$/m, // Gmail, Apple Mail — the attribution may wrap onto a second line
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From:[^\n]*\n(?:Sent|Date):/m, // Outlook
  /^_{10,}[ \t]*$/m, // Outlook separator
  /^في [\s\S]{0,300}?كتب[^\n]{0,200}:[ \t]*$/m // Gmail, Arabic UI
]

/** The new text of a reply, without the history it quotes. Never empty when the input was not. */
export function stripQuoted(text: string): string {
  const t = text.replace(/\r\n/g, '\n')
  let cut = t.length
  for (const re of QUOTE_START) {
    const m = re.exec(t)
    if (m && m.index < cut) cut = m.index
  }
  const kept = t.slice(0, cut).split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim()
  return kept || t.trim()
}

/** Reply-To wins over From; every other address on the message is Cc'd, never the owner. */
export function replyRecipients(latest: ThreadMsg, selfEmail: string): { to: string, cc: string[] } {
  const self = selfEmail.toLowerCase()
  const to = addresses(headerOf(latest, 'Reply-To'))[0] ?? addresses(headerOf(latest, 'From'))[0] ?? ''
  const everyone = [...addresses(headerOf(latest, 'From')), ...addresses(headerOf(latest, 'To')), ...addresses(headerOf(latest, 'Cc'))]
  return { to, cc: [...new Set(everyone)].filter(a => a !== self && a !== to) }
}

/** Gmail gives an edited draft a new message id, so an unchanged id is the proof nobody touched it. */
export const isUnedited = (storedMsgId: string | null, currentMsgId: string | null): boolean =>
  !!storedMsgId && storedMsgId === currentMsgId

/**
 * Whether a poll writes its time to inbox_state. Every write moves data_version, and the hand-off pushes an
 * 8 MB snapshot whenever that moved — so an idle poll writes only when the stored value is an hour stale.
 * The live value lives on globalThis; after a restart the search's hour of overlap covers the stale one.
 */
export const shouldSavePoll = (stored: number, savedAt: number | null, now: number): boolean =>
  stored > 0 || savedAt === null || now - savedAt > 3600
