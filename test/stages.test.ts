import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMime, findAttachment, renderHtml } from '../server/utils/gmail.ts'
import { classifyMessage, decideStage, FOLLOW_UP_AFTER_MS, untilDue, type GmailMessage } from '../server/utils/stages.ts'

const ME = 'me@gmail.com'
const REC = 'hr@acme.sa'
const NOW = Date.parse('2026-09-10T12:00:00Z')

const msg = (over: Partial<GmailMessage> = {}): GmailMessage => ({
  id: 'm1', threadId: 't1', from: `Recruiter <${REC}>`, subject: 'Re: role', snippet: 'hello', date: NOW, ...over
})

const base = { selfEmail: ME, recruiterEmail: REC, dbStage: null, hasPendingDraft: false, now: NOW }

// ---------------- classification ----------------

test('a message from the connected account is outgoing', () => {
  assert.equal(classifyMessage(msg({ from: `Mohamed <${ME}>` }), ME, REC), 'outgoing')
})

test('a bounce is not a reply', () => {
  assert.equal(classifyMessage(msg({ from: 'mailer-daemon@googlemail.com' }), ME, REC), 'bounce')
  assert.equal(classifyMessage(msg({ from: 'x@acme.sa', subject: 'Undeliverable: your message' }), ME, REC), 'bounce')
})

test('an auto-reply is not a reply', () => {
  // treating one as a human answer would stop a live application dead
  assert.equal(classifyMessage(msg({ from: 'no-reply@acme.sa' }), ME, REC), 'auto-reply')
  assert.equal(classifyMessage(msg({ subject: 'Automatic reply: out of office' }), ME, REC), 'auto-reply')
  assert.equal(classifyMessage(msg({ snippet: 'We have received your application' }), ME, REC), 'auto-reply')
})

test('a human from the recruiter address or its domain is a reply', () => {
  assert.equal(classifyMessage(msg(), ME, REC), 'reply')
  assert.equal(classifyMessage(msg({ from: 'someone.else@acme.sa' }), ME, REC), 'reply')
})

test('an unrelated sender is neither', () => {
  assert.equal(classifyMessage(msg({ from: 'newsletter@other.com' }), ME, REC), 'other')
})

// ---------------- the 8 rows ----------------

test('row 1: a bounce closes the address permanently', () => {
  const d = decideStage({ ...base, messages: [msg({ from: 'mailer-daemon@google.com' })] })
  assert.equal(d.row, 1)
  assert.equal(d.stage, 'final')
  assert.equal(d.action, 'none')
})

test('row 2: a reply hands it to him, nothing automatic', () => {
  const d = decideStage({ ...base, messages: [msg({ from: `Recruiter <${REC}>` })] })
  assert.equal(d.row, 2)
  assert.equal(d.stage, 'replied')
  assert.equal(d.action, 'none')
})

test('row 2 beats row 3: a reply after two sends is still a reply', () => {
  const d = decideStage({ ...base, messages: [
    msg({ id: 'a', from: ME, date: NOW - 10 * 86400e3 }),
    msg({ id: 'b', from: ME, date: NOW - 5 * 86400e3 }),
    msg({ id: 'c', from: REC, date: NOW - 1 * 86400e3 })
  ] })
  assert.equal(d.row, 2)
})

test('row 3: two emails sent and silence is the ceiling — never a third', () => {
  const d = decideStage({ ...base, messages: [
    msg({ id: 'a', from: ME, date: NOW - 10 * 86400e3 }),
    msg({ id: 'b', from: ME, date: NOW - 5 * 86400e3 })
  ] })
  assert.equal(d.row, 3)
  assert.equal(d.stage, 'final')
  assert.equal(d.postsReason, 'recruiter final')
})

test('row 4: a written follow-up waiting to be sent is left alone', () => {
  const d = decideStage({
    ...base,
    dbStage: 'followed_up',
    hasPendingDraft: true,
    messages: [msg({ from: ME, date: NOW - 5 * 86400e3 })]
  })
  assert.equal(d.row, 4)
  assert.equal(d.action, 'send-the-follow-up')
})

test('row 5: inside 72 hours we wait, and report when it is due', () => {
  const sent = NOW - 40 * 3600e3
  const d = decideStage({ ...base, messages: [msg({ from: ME, date: sent })] })
  assert.equal(d.row, 5)
  assert.equal(d.stage, 'contacted')
  assert.equal(d.followUpDueAt, sent + FOLLOW_UP_AFTER_MS)
})

test('row 6: at exactly 72 hours the follow-up becomes due', () => {
  const sent = NOW - FOLLOW_UP_AFTER_MS
  const d = decideStage({ ...base, messages: [msg({ from: ME, date: sent })] })
  assert.equal(d.row, 6)
  assert.equal(d.action, 'draft-the-follow-up')
  assert.equal(d.postsReason, 'named in follow-up', 'the prefix the follow-up query depends on')
})

test('row 6 boundary: one minute short is still row 5', () => {
  const sent = NOW - FOLLOW_UP_AFTER_MS + 60_000
  assert.equal(decideStage({ ...base, messages: [msg({ from: ME, date: sent })] }).row, 5)
})

test('row 7: an unsent application draft is never edited', () => {
  const d = decideStage({ ...base, dbStage: 'drafted', hasPendingDraft: true, messages: [] })
  assert.equal(d.row, 7)
  assert.equal(d.action, 'send-the-application')
})

test('row 8: a fresh recruiter gets screened and drafted', () => {
  const d = decideStage({ ...base, messages: [] })
  assert.equal(d.row, 8)
  assert.equal(d.action, 'draft-the-application')
})

test('an auto-reply alone never counts as contact or reply', () => {
  const sent = NOW - 5 * 86400e3
  const d = decideStage({ ...base, messages: [
    msg({ id: 'a', from: ME, date: sent }),
    msg({ id: 'b', from: 'no-reply@acme.sa', date: sent + 60_000 })
  ] })
  assert.equal(d.row, 6, 'the follow-up is still due despite the autoresponder')
})

test('untilDue reads as a countdown', () => {
  assert.equal(untilDue(null, NOW), null)
  assert.equal(untilDue(NOW - 1000, NOW), 'due now')
  assert.equal(untilDue(NOW + 5 * 3600e3, NOW), 'in 5h')
  assert.equal(untilDue(NOW + 50 * 3600e3, NOW), 'in 2d')
})

// ---------------- MIME ----------------

test('buildMime nests the PDF alongside the text and html parts', () => {
  const pdf = Buffer.from('%PDF-1.4 ' + 'x'.repeat(300))
  const raw = buildMime({ to: REC, subject: 'Role', text: 'hello & bye', html: '<p>hi</p>' }, 'cv.pdf', pdf)
  assert.match(raw, /^To: hr@acme\.sa\r\n/)
  assert.match(raw, /Content-Type: multipart\/mixed/)
  assert.match(raw, /Content-Type: multipart\/alternative/)
  assert.match(raw, /Content-Disposition: attachment; filename="cv\.pdf"/)
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/)
  assert.match(raw, /Content-Type: text\/html; charset=UTF-8/)
})

test('buildMime encodes a non-ASCII subject', () => {
  assert.match(buildMime({ to: REC, subject: 'Rôle — Vue', text: 'x' }), /Subject: =\?UTF-8\?B\?/)
})

test('buildMime works with no attachment (the follow-up carries none by itself)', () => {
  const raw = buildMime({ to: REC, text: 'ping', inReplyTo: '<m1@x>' })
  assert.match(raw, /In-Reply-To: <m1@x>/)
  assert.doesNotMatch(raw, /application\/pdf/)
})

test('renderHtml turns bare URLs into real anchors', () => {
  // Gmail rewrites bare URLs in a plain body into google.com/url?q= redirects; two applications went out that way
  const html = renderHtml('See my work', 'Mohamed\nhttps://github.com/melrefaie')
  assert.match(html, /<a href="https:\/\/github\.com\/melrefaie">github\.com\/melrefaie<\/a>/)
})

test('renderHtml escapes HTML rather than emitting it', () => {
  const html = renderHtml('a & b <script>alert(1)</script>', 'sig')
  assert.match(html, /a &amp; b &lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})

test('findAttachment locates the PDF at any nesting depth', () => {
  const payload = { parts: [{ parts: [{ filename: '', mimeType: 'text/plain' }] }, { filename: 'cv.pdf', body: { size: 1381 } }] }
  assert.equal(findAttachment(payload, 'cv.pdf'), 1381)
  assert.equal(findAttachment(payload, 'other.pdf'), null)
})
