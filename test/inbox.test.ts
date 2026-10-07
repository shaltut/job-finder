// The inbox's pure decisions. See docs/superpowers/specs/2026-10-07-inbox-replies-design.md.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addresses, isInbound, isUnedited, ownerAnswered, plainBody, replyRecipients, shouldSavePoll, stripQuoted, threadContact, type ThreadMsg
} from '../server/utils/inbox-core.ts'

const SELF = 'me@example.com'
const msg = (id: string, labels: string[], headers: Record<string, string>, date = 1, body = ''): ThreadMsg => ({
  id, threadId: 't1', labelIds: labels, internalDate: String(date),
  payload: {
    mimeType: 'text/plain',
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    body: { data: Buffer.from(body).toString('base64url') }
  }
})

test('addresses pulls every address out of a header, lower-cased and deduped', () => {
  assert.deepEqual(addresses('"Jane D" <Jane@Acme.com>, bob@acme.com; jane@acme.com'), ['jane@acme.com', 'bob@acme.com'])
  assert.deepEqual(addresses(''), [])
})

test('a thread qualifies only through a SENT message from the owner to a known contact', () => {
  const contacts = new Set(['hr@acme.com'])
  const sent = msg('a', ['SENT'], { From: `Me <${SELF}>`, To: 'HR <hr@acme.com>' })
  const reply = msg('b', ['INBOX'], { From: 'Lee <lee@other.io>', To: SELF }, 2)
  assert.equal(threadContact([sent, reply], SELF, contacts), 'hr@acme.com')
  assert.equal(threadContact([msg('a', ['SENT'], { From: SELF, To: 'stranger@x.com' }), reply], SELF, contacts), null, 'sent to a stranger')
  assert.equal(threadContact([msg('a', ['DRAFT', 'SENT'], { From: SELF, To: 'hr@acme.com' }), reply], SELF, contacts), null, 'a draft is not a sent email')
  assert.equal(threadContact([reply], SELF, contacts), null, 'nothing of ours in it')
})

test('inbound means not ours, not sent, not a draft', () => {
  assert.equal(isInbound(msg('b', ['INBOX'], { From: 'lee@other.io' }), SELF), true)
  assert.equal(isInbound(msg('b', ['SENT'], { From: SELF }), SELF), false)
  assert.equal(isInbound(msg('b', ['INBOX'], { From: `Me <${SELF}>` }), SELF), false)
  assert.equal(isInbound(msg('b', ['DRAFT'], { From: 'lee@other.io' }), SELF), false)
})

test('plainBody prefers text/plain, falls back to stripped html', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url')
  assert.equal(plainBody({ mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
    { mimeType: 'text/plain', body: { data: b64('plain') } }
  ] }), 'plain')
  assert.equal(plainBody({ mimeType: 'text/html', body: { data: b64('<div>Hi&nbsp;there<br>Lee</div>') } }).trim(), 'Hi there\nLee')
  assert.equal(plainBody(undefined), '')
})

test('stripQuoted keeps only the new text', () => {
  assert.equal(stripQuoted('Thanks, can you talk Tuesday?\n\nOn Mon, 5 Oct 2026 at 10:00, Me <me@example.com> wrote:\n> my application'), 'Thanks, can you talk Tuesday?')
  assert.equal(stripQuoted('Sure.\r\nOn Mon, 5 Oct 2026 at 10:00 Me <\r\nme@example.com> wrote:\r\n> old'), 'Sure.', 'a wrapped Gmail attribution line')
  assert.equal(stripQuoted('Yes.\n\nFrom: Me <me@example.com>\nSent: Monday\nTo: hr@acme.com\n\nold'), 'Yes.', 'Outlook block')
  assert.equal(stripQuoted('Yes.\n________________________________\nFrom: Me'), 'Yes.', 'Outlook separator')
  assert.equal(stripQuoted('تمام\n\nفي الاثنين، ٥ أكتوبر ٢٠٢٦ كتب Me <me@example.com>:\n> قديم'), 'تمام', 'Arabic Gmail attribution')
  assert.equal(stripQuoted('line one\n> quoted\nline two'), 'line one\nline two', 'inline > lines dropped')
  assert.equal(stripQuoted('> only a quote'), '> only a quote', 'nothing left: keep the original rather than an empty body')
})

test('the reply goes to Reply-To, else From; everyone else on the message is Cc, never the owner', () => {
  const latest = msg('b', ['INBOX'], { From: 'Lee <lee@other.io>', To: `${SELF}, hr@acme.com`, Cc: 'boss@acme.com, Lee <lee@other.io>' })
  assert.deepEqual(replyRecipients(latest, SELF), { to: 'lee@other.io', cc: ['hr@acme.com', 'boss@acme.com'] })
  const viaReplyTo = msg('b', ['INBOX'], { 'From': 'noreply@ats.io', 'Reply-To': 'Lee <lee@other.io>', 'To': SELF })
  assert.deepEqual(replyRecipients(viaReplyTo, SELF), { to: 'lee@other.io', cc: ['noreply@ats.io'] })
})

test('an app draft is unedited only when its message id has not moved', () => {
  assert.equal(isUnedited('m1', 'm1'), true)
  assert.equal(isUnedited('m1', 'm2'), false, 'Gmail gives an edited draft a new message id')
  assert.equal(isUnedited(null, 'm1'), false, 'no record: treat as the owner\'s')
})

test('an idle poll writes its time only when the stored one is an hour stale', () => {
  // each write moves data_version and the hand-off pushes an 8 MB snapshot for it
  assert.equal(shouldSavePoll(0, 10_000, 10_300), false, 'nothing stored, five minutes on: no write')
  assert.equal(shouldSavePoll(0, 10_000, 13_600), false, 'exactly an hour: still within the overlap')
  assert.equal(shouldSavePoll(0, 10_000, 13_601), true)
  assert.equal(shouldSavePoll(2, 10_000, 10_300), true, 'a poll that stored rows is writing anyway')
  assert.equal(shouldSavePoll(0, null, 10_300), true, 'the first poll records itself, or every restart backfills 30 days')
})

test('ownerAnswered: a message of ours newer than the reply means it is answered; a draft does not count', () => {
  const app = msg('a', ['SENT'], { From: SELF, To: 'hr@acme.com' }, 1)
  const reply = msg('b', ['INBOX'], { From: 'hr@acme.com', To: SELF }, 2)
  const mine = msg('c', ['SENT'], { From: SELF, To: 'hr@acme.com' }, 3)
  const ooo = msg('d', ['INBOX'], { From: 'hr@acme.com', To: SELF }, 4)
  assert.equal(ownerAnswered([app, reply], SELF, 'b'), false, 'waiting on us')
  assert.equal(ownerAnswered([app, reply, mine], SELF, 'b'), true, 'answered in Gmail')
  assert.equal(ownerAnswered([app, reply, mine, ooo], SELF, 'b'), true, 'an auto-reply after our answer does not reopen it')
  assert.equal(ownerAnswered([app, reply, msg('c', ['DRAFT'], { From: SELF }, 3)], SELF, 'b'), false, 'a pending draft is not an answer')
  assert.equal(ownerAnswered([app, reply], SELF, 'gone'), false)
})
