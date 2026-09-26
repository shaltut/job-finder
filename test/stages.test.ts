import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMime, ccFrom, findAttachment, renderHtml, replyHeaders } from '../server/utils/gmail.ts'
import { cachedStage, classifyMessage, closedBy, decideStage, FOLLOW_UP_AFTER_MS, untilDue, type GmailMessage } from '../server/utils/stages.ts'

const ME = 'me@gmail.com'
const REC = 'hr@acme.sa'
const NOW = Date.parse('2026-09-10T12:00:00Z')

const msg = (over: Partial<GmailMessage> = {}): GmailMessage => ({
  id: 'm1', threadId: 't1', from: `Recruiter <${REC}>`, subject: 'Re: role', snippet: 'hello', date: NOW, ...over
})

const base = { selfEmail: ME, recruiterEmail: REC, dbStage: null, hasPendingDraft: false, now: NOW }

// ---------------- classification ----------------

test('a message from the connected account is outgoing', () => {
  assert.equal(classifyMessage(msg({ from: `Test Person <${ME}>` }), ME, REC), 'outgoing')
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

test('row 6 is cached as contacted with a countdown, never as followed_up before a draft exists', () => {
  // Measured 2026-09-25: 76 of 79 followed_up recruiters had no follow-up at all, because the sweep wrote
  // the stage before trying to draft. persist() is what promotes a recruiter once a draft really exists.
  const sent = NOW - 4 * 86400e3
  const d = decideStage({ ...base, messages: [msg({ from: ME, date: sent })] })
  assert.equal(d.row, 6)
  const c = cachedStage(d)
  assert.equal(c.stage, 'contacted')
  // the exact shape pipeline.vue's due() parses, so the hand-off reads "follow-up due now"
  const m = c.note.match(/follow-up due (.+)$/)
  assert.equal(Date.parse(m![1]!), sent + FOLLOW_UP_AFTER_MS)
})

test('every other row is cached exactly as decided', () => {
  const out = msg({ from: ME, date: NOW - 5 * 86400e3 })
  for (const d of [
    decideStage({ ...base, messages: [msg({ from: 'mailer-daemon@x.com', subject: 'Undeliverable' })] }),
    decideStage({ ...base, messages: [out, msg({ date: NOW })] }),
    decideStage({ ...base, messages: [out, msg({ from: ME, date: NOW })] }),
    decideStage({ ...base, hasPendingDraft: true, messages: [out] }),
    decideStage({ ...base, messages: [msg({ from: ME, date: NOW - 3600e3 })] }),
    decideStage({ ...base, hasPendingDraft: true, messages: [] }),
    decideStage({ ...base, messages: [] })
  ]) assert.deepEqual(cachedStage(d), { stage: d.stage, note: d.note }, `row ${d.row}`)
})

test('row 4 without followed_up cached: a follow-up the owner wrote by hand is never doubled', () => {
  // The hand-off case. Row 6 now caches `contacted`, so the owner's own follow-up draft sits beside that
  // stage — and keying row 4 on dbStage would have drafted a second follow-up next to theirs.
  const d = decideStage({
    ...base, dbStage: 'contacted', hasPendingDraft: true, messages: [msg({ from: ME, date: NOW - 5 * 86400e3 })]
  })
  assert.equal(d.row, 4)
  assert.equal(d.action, 'send-the-follow-up')
  assert.equal(closedBy(d), 'follow-up draft pending, send it', 'and the draft gate stays shut')
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
  const html = renderHtml('See my work', 'Test Person\nhttps://github.com/testperson')
  assert.match(html, /<a href="https:\/\/github\.com\/testperson">github\.com\/testperson<\/a>/)
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

// ---------------- Cc ----------------
//
// The post that prompted this said "send to X / CC Y" and the draft went to X alone, so the person who
// screens the CVs never saw it. Both addresses were in posts.emails the whole time; only emails[0] was used.

test('buildMime carries a Cc when given one and omits the header entirely when not', () => {
  const withCc = buildMime({ to: REC, cc: 'reem@acme.sa', subject: 'Role', text: 'x' })
  assert.ok(withCc.includes('Cc: reem@acme.sa'), 'Cc header missing')
  assert.ok(!buildMime({ to: REC, subject: 'Role', text: 'x' }).includes('Cc:'), 'empty Cc must not emit a header')
})

test('ccFrom keeps the other addresses, drops the recipient and the owner, and dedupes case', () => {
  const lists = [['hr@acme.sa', 'Reem@acme.sa'], ['reem@acme.sa', 'owner@mine.com']]
  assert.deepEqual(ccFrom(lists, 'hr@acme.sa', 'owner@mine.com'), ['reem@acme.sa'])
})

test('ccFrom excludes the recipient wherever it sits, not just at index 0', () => {
  // the follow-up sweep finds a contact through json_each at any index, so position proves nothing
  assert.deepEqual(ccFrom([['second@acme.sa', 'first@acme.sa']], 'first@acme.sa'), ['second@acme.sa'])
})

test('ccFrom returns nothing when the post named one address', () => {
  assert.deepEqual(ccFrom([['hr@acme.sa']], 'hr@acme.sa'), [])
})

// ---------------- threading the follow-up onto the application ----------------

test('row 6 hands back the application message, so the follow-up can reply to it', () => {
  const sent = NOW - FOLLOW_UP_AFTER_MS
  const application = msg({
    id: 'app', threadId: 'thread-1', messageId: '<app@mail.gmail.com>',
    subject: 'Senior .NET Developer — Application', from: ME, date: sent
  })
  const d = decideStage({ ...base, messages: [application] })
  assert.equal(d.row, 6)
  assert.equal(d.replyTo?.threadId, 'thread-1')
  assert.equal(d.replyTo?.messageId, '<app@mail.gmail.com>')
})

test('the follow-up inherits the application subject verbatim and claims all three criteria', () => {
  // Gmail joins a draft to a thread only when threadId, RFC 2822 In-Reply-To/References AND a matching
  // Subject are all present. The model returns a subject of its own regardless of the procedure telling
  // it not to — "Follow up" went out on 17 Sep — so the subject is taken from the thread, in code.
  const h = replyHeaders({ threadId: 'thread-1', messageId: '<app@mail>', subject: 'Senior .NET Developer' })
  assert.equal(h.subject, 'Senior .NET Developer', 'verbatim is the only form the matching-Subject rule guarantees')
  assert.equal(h.inReplyTo, '<app@mail>')
  assert.equal(h.references, '<app@mail>')
  assert.equal(h.threadId, 'thread-1')
})

test('without a Message-ID the follow-up keeps the subject but never claims the thread', () => {
  // Fail open, the way every derived flag rule does: a detached email carrying the real role name beats
  // one titled "Follow up". Claiming the thread without the headers is what Gmail rejects.
  const h = replyHeaders({ threadId: 'thread-1', subject: 'Senior .NET Developer' })
  assert.equal(h.subject, 'Senior .NET Developer')
  assert.equal(h.threadId, undefined, 'all three criteria or none of them')
  assert.equal(h.inReplyTo, undefined)
})

test('no application message at all leaves every header to the caller', () => {
  assert.deepEqual(replyHeaders(undefined), {})
})

// ---------------- the draft gate, asked of Gmail ----------------

/** Every row of the table, built through decideStage rather than hand-assembled. */
const allRows = (): Record<number, ReturnType<typeof decideStage>> => {
  const sent = NOW - FOLLOW_UP_AFTER_MS
  const out = (over = {}) => msg({ from: ME, date: sent, ...over })
  return {
    1: decideStage({ ...base, messages: [msg({ from: 'mailer-daemon@googlemail.com' })] }),
    2: decideStage({ ...base, messages: [msg()] }),
    3: decideStage({ ...base, messages: [out(), out({ id: 'm2', date: sent + 1000 })] }),
    4: decideStage({ ...base, dbStage: 'followed_up', hasPendingDraft: true, messages: [out()] }),
    5: decideStage({ ...base, messages: [out({ date: NOW - 1000 })] }),
    6: decideStage({ ...base, messages: [out()] }),
    7: decideStage({ ...base, hasPendingDraft: true, messages: [] }),
    8: decideStage({ ...base, messages: [] })
  }
}

test('only a recruiter Gmail has never been written to is open for an application', () => {
  const rows = allRows()
  assert.equal(closedBy(rows[8]!), false, 'row 8 is the one row that earns an application')
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.notEqual(closedBy(rows[n]!), false, `row ${n} must not earn a second application`)
  }
})

test('row 5 closes the door: a recruiter already written to gets the follow-up, not a second application', () => {
  // The behaviour the contacts cache had backwards — `contacted` was not closed, so a new post from a
  // recruiter already emailed once earned a second application, burning the two-emails ceiling on a role
  // the follow-up is meant to carry ("one line naming any further roles from this recruiter").
  assert.match(String(closedBy(allRows()[5]!)), /follow-up due/)
})

test('a skip reason never starts with "named in": that prefix means an email already named the post', () => {
  // applications.reason is where this lands, and the follow-up query finds unmentioned roles with
  // `reason NOT LIKE 'named in %'`. Row 6's postsReason IS 'named in follow-up', so reusing that field
  // here would tell the follow-up its own posts were already covered and silently empty it.
  for (const [n, d] of Object.entries(allRows())) {
    const reason = closedBy(d)
    if (reason !== false) assert.doesNotMatch(reason, /^named in /, `row ${n} would poison the follow-up query`)
  }
})

test('row 9: a follow-up drafted and deleted unsent is never drafted again', () => {
  // The review of 1ae6874 reproduced it: delete a follow-up draft, and every later sweep wrote another.
  // `followed_up` is cached only once persist() has created one, so this combination means it is gone.
  const d = decideStage({ ...base, dbStage: 'followed_up', hasPendingDraft: false, messages: [msg({ from: ME, date: NOW - 6 * 86400e3 })] })
  assert.equal(d.row, 9)
  assert.equal(d.action, 'none')
  assert.equal(cachedStage(d).stage, 'followed_up', 'and it stays that way on the next sweep')
  assert.ok(closedBy(d), 'nor does the draft gate open for a second application')
})

test('control: a recruiter never followed up still gets the follow-up at row 6', () => {
  const d = decideStage({ ...base, dbStage: 'contacted', hasPendingDraft: false, messages: [msg({ from: ME, date: NOW - 6 * 86400e3 })] })
  assert.equal(d.row, 6)
  assert.equal(d.action, 'draft-the-follow-up')
})
