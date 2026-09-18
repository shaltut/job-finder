import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findFinishedMatch, PASTE_STALE_MS, stalePastes } from '../shared/paste-poll.ts'

// Four sequences a reviewer traced by hand against jobs.ts's pump()/finish() before this shipped.
// findFinishedMatch is the one line standing between the paste card and two misattribution bugs, so
// each sequence gets its own test rather than a comment above the implementation.

test('paste A, then paste B before A finishes: A finishing resolves A, not B', () => {
  const a = { text: 'post A text', at: 1000 }
  const b = { text: 'post B text', at: 1500 }
  const lastA = { log: ['stored: Role A'], endedAt: new Date(2000).toISOString(), args: { text: a.text } }

  const match = findFinishedMatch([a, b], lastA)

  assert.equal(match, a)
})

test('"Paste again" after a failure creates a new entry the failed job can never resolve', () => {
  // The failed attempt's own job already landed in `last` before the retry was even submitted.
  const staleFailure = { log: ['failed: scoring error'], endedAt: new Date(2000).toISOString(), args: { text: 'same post' } }
  const retry = { text: 'same post', at: 2500 } // created after the failed attempt's endedAt

  assert.equal(findFinishedMatch([retry], staleFailure), null)

  // Once the retry's own job actually finishes, it resolves normally.
  const freshSuccess = { log: ['stored: Role'], endedAt: new Date(3000).toISOString(), args: { text: 'same post' } }
  assert.equal(findFinishedMatch([retry], freshSuccess), retry)
})

test('a stale last job with no matching queued entry touches nothing', () => {
  // Paste A finishes and is removed from the local queued list; pasting A's text again later hits the
  // endpoint's duplicate check before enqueue(), so no new entry is ever created for it.
  const staleLast = { log: ['stored: Role A'], endedAt: new Date(1000).toISOString(), args: { text: 'post A text' } }

  assert.equal(findFinishedMatch([], staleLast), null)

  // A different post is queued, but `last` still names the old, already-resolved text.
  const other = { text: 'post C text', at: 500 }
  assert.equal(findFinishedMatch([other], staleLast), null)
})

test('two pastes finishing inside one tick: the earlier entry is never mis-stamped with the later result', () => {
  const a = { text: 'post A text', at: 1000 }
  const b = { text: 'post B text', at: 1200 }
  // B's job overwrote the lane's single `last` slot before any poll observed A's own completion.
  const lastB = { log: ['stored: Role B'], endedAt: new Date(1400).toISOString(), args: { text: b.text } }

  const match = findFinishedMatch([a, b], lastB)

  assert.equal(match, b)
  assert.notEqual(match, a)
})

test('stalePastes leaves a still-plausibly-running entry alone and gives up only past the bound', () => {
  const now = 10 * PASTE_STALE_MS
  const justSubmitted = { text: 'fresh', at: now - 1000 }
  const pastTheBound = { text: 'stuck', at: now - (PASTE_STALE_MS + 1) }

  assert.deepEqual(stalePastes([justSubmitted, pastTheBound], now), [pastTheBound])
})

test('the two properties compose: a finish-collision victim is left queued until it goes stale', () => {
  const a = { text: 'post A text', at: 1000 }
  const b = { text: 'post B text', at: 1200 }
  const lastB = { log: ['stored: Role B'], endedAt: new Date(1400).toISOString(), args: { text: b.text } }

  // Neither call resolves A: it was not matched, and it has not been queued long enough to be stale.
  assert.equal(findFinishedMatch([a], lastB), null)
  assert.deepEqual(stalePastes([a], 1200 + 1000), [])

  // Once enough wall-clock time passes, the same entry is finally given up on.
  assert.deepEqual(stalePastes([a], a.at + PASTE_STALE_MS + 1), [a])
})

// The bound itself: generous enough that the tenth of ten sequential jobs, each budgeted well above a
// single gpt-5-nano scoring call, still resolves before its own entry is given up on.
test('PASTE_STALE_MS covers ten sequential paste jobs at a generous 30s each', () => {
  assert.ok(10 * 30_000 <= PASTE_STALE_MS, 'ten queued pastes must never trip the staleness cap')
})
