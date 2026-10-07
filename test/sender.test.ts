// The draft sender's decisions (server/utils/sender-core.ts). Sending is the one thing this app could not
// do until 2026-10-05, so every refusal it can make is pinned here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftText, modeOf, pickBatch, sendable } from '../server/utils/sender-core.ts'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const draft = (body: string, withPdf = true, subject = 'Application: .NET Lead') => ({
  id: 'r1',
  message: {
    id: 'm1',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'To', value: 'Jane <jane@acme.example>' }, { name: 'Subject', value: subject }],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', body: { data: b64(body) } },
          { mimeType: 'text/html', body: { data: b64(`<p>${body}</p>`) } }
        ] },
        ...(withPdf ? [{ mimeType: 'application/pdf', filename: 'CV.pdf', body: { attachmentId: 'a1' } }] : [])
      ]
    }
  }
})

test('draftText reads the recipient, subject, plain body and whether a PDF rides along', () => {
  const t = draftText(draft('Dear Jane,\nI am applying.'))
  assert.equal(t.to, 'jane@acme.example')
  assert.equal(t.subject, 'Application: .NET Lead')
  assert.equal(t.body, 'Dear Jane,\nI am applying.')
  assert.equal(t.hasPdf, true)
  assert.equal(draftText(draft('x', false)).hasPdf, false)
})

test('sendable: only a clean draft to a recruiter whose Gmail still says "draft pending"', () => {
  const ok = { subject: 'Application', body: 'Dear Jane', hasPdf: true, action: 'send-the-application', mode: 'apply', recipientMatches: true, sentBefore: false, sentThisRound: false }
  assert.deepEqual(sendable(ok), { ok: true })
  assert.deepEqual(sendable({ ...ok, mode: 'follow-up', action: 'send-the-follow-up' }), { ok: true })
  assert.match((sendable({ ...ok, body: 'Expected salary: [ADD BEFORE SENDING]' }) as { reason: string }).reason, /placeholder/)
  assert.match((sendable({ ...ok, subject: 'TBD' }) as { reason: string }).reason, /placeholder/)
  assert.match((sendable({ ...ok, hasPdf: false }) as { reason: string }).reason, /no CV/)
  assert.match((sendable({ ...ok, action: 'none' }) as { reason: string }).reason, /no longer pending/)
  assert.match((sendable({ ...ok, action: 'draft-the-follow-up' }) as { reason: string }).reason, /no longer pending/)
})

test('pickBatch: n distinct ids, all of them when fewer, random order', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const batch = pickBatch(ids, 3, () => 0.5)
  assert.equal(batch.length, 3)
  assert.equal(new Set(batch).size, 3)
  assert.ok(batch.every(id => ids.includes(id)))
  assert.deepEqual(pickBatch(ids, 10, Math.random).sort(), ids)
  assert.deepEqual(pickBatch([], 10, Math.random), [])
  assert.notDeepEqual(pickBatch(ids, 5, () => 0), ids, 'shuffled, not the stored order')
})

// review 2026-10-05: the stage check alone let a second application through
const base = { subject: 'Application', body: 'Dear Jane', hasPdf: true, action: 'send-the-application', mode: 'apply', recipientMatches: true, sentBefore: false, sentThisRound: false }

test('an application goes out only as an application, a follow-up only as a follow-up', () => {
  assert.deepEqual(sendable(base), { ok: true })
  assert.deepEqual(sendable({ ...base, mode: 'follow-up', action: 'send-the-follow-up' }), { ok: true })
  assert.match((sendable({ ...base, action: 'send-the-follow-up' }) as { reason: string }).reason, /application.*already/,
    'an apply draft while one email is already out is a second application')
  assert.match((sendable({ ...base, mode: 'follow-up' }) as { reason: string }).reason, /follow-up.*before/)
})

test('a local record refuses a second email of the same kind — Gmail search can lag a send by minutes', () => {
  assert.match((sendable({ ...base, sentBefore: true }) as { reason: string }).reason, /already sent/)
  assert.match((sendable({ ...base, sentThisRound: true }) as { reason: string }).reason, /this round/)
})

test('a changed recipient or an empty body is held back', () => {
  assert.match((sendable({ ...base, recipientMatches: false }) as { reason: string }).reason, /recipient changed/)
  assert.match((sendable({ ...base, body: '  ' }) as { reason: string }).reason, /empty/)
})

test('sendable: never to a recruiter the inbox has marked replied', () => {
  // a colleague's reply is invisible to decideStage(), so Gmail can still say "pending"; the cached stage is the stop
  assert.match((sendable({ ...base, stage: 'replied' }) as { reason: string }).reason, /replied.*Inbox/)
  assert.match((sendable({ ...base, mode: 'follow-up', action: 'send-the-follow-up', stage: 'replied' }) as { reason: string }).reason, /replied/)
  assert.deepEqual(sendable({ ...base, stage: 'drafted' }), { ok: true })
})

// review 2026-10-05 / owner: follow-up drafts made before app_drafts existed were invisible to the sender.
// What a draft IS comes from Gmail: a reply inside a thread where we already wrote is a follow-up.
test('modeOf: a draft in a thread we already sent in is a follow-up, otherwise an application', () => {
  const sent = { labelIds: ['SENT'] }
  const draftMsg = { labelIds: ['DRAFT'] }
  const theirs = { labelIds: ['INBOX'] }
  assert.equal(modeOf([sent, draftMsg]), 'follow-up')
  assert.equal(modeOf([draftMsg]), 'apply')
  assert.equal(modeOf([theirs, draftMsg]), 'apply', 'a thread they started is not one we sent in')
  assert.equal(modeOf([{ labelIds: ['SENT', 'DRAFT'] }]), 'apply', 'the draft itself does not count')
  assert.equal(modeOf([]), 'apply')
})
