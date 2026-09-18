import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findFinishedMatch, PASTE_STALE_MS, stalePastes, type FinishedPasteJob } from '../shared/paste-poll.ts'

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

// Mutation-testing gaps found in review round 2: three mutants of this file's own logic survived the
// tests above. Each of the three below was confirmed to catch its mutant (and only its mutant) before
// being added — see task-5-report.md, "Fix round 2".

test('findFinishedMatch returns null for an absent or unfinished last job, and never throws', () => {
  const queued = [{ text: 'post A text', at: 1000 }]

  // Fresh page load: `lanes.paste.last` is null until some paste job has ever finished.
  assert.equal(findFinishedMatch(queued, null), null)

  // A job that has started running but not yet finished carries no endedAt.
  const running = { log: [], endedAt: null, args: { text: 'post A text' } }
  assert.equal(findFinishedMatch(queued, running), null)
})

test('findFinishedMatch: endedAt is an exclusive bound, not inclusive', () => {
  const p = { text: 'post A text', at: 1000 }
  // The job "ends" at the exact millisecond the entry was created — not after it, so it must not match.
  const last = { log: ['stored: Role A'], endedAt: new Date(p.at).toISOString(), args: { text: p.text } }

  assert.equal(findFinishedMatch([p], last), null)
})

test('stalePastes: the staleness bound is exclusive, not inclusive', () => {
  const p = { text: 'post A text', at: 1000 }

  // Exactly PASTE_STALE_MS elapsed is not yet stale...
  assert.deepEqual(stalePastes([p], p.at + PASTE_STALE_MS), [])
  // ...one more millisecond is.
  assert.deepEqual(stalePastes([p], p.at + PASTE_STALE_MS + 1), [p])
})

// Round 2 closed one specific missing-field gap (`last: null`) with a mutation caught by the test
// above. A second mutation-testing pass (round 3) found a sibling gap the same way: `last.args.text`
// (dropping the `?.`) also throws, and no test supplied a `last` whose `args` is missing — even though
// `FinishedPasteJob.args` is typed optional, so the type itself says that shape is expected. Rather than
// adding one test per optional field forever, this asserts the property directly: `findFinishedMatch`
// is total over every malformed `last` — it returns null and never throws, no matter which optional
// piece is missing. Each fixture is cast past the type system on purpose, because the point is a
// runtime guarantee against shapes the compiler would otherwise never let through.
test('findFinishedMatch is total: null and never a throw, for every malformed last', () => {
  const queued = [{ text: 'post A text', at: 1000 }]
  const validEndedAt = new Date(2000).toISOString()

  const cases: { label: string, last: unknown }[] = [
    { label: 'last: null', last: null },
    { label: 'last: undefined', last: undefined },
    { label: 'last: {} (no endedAt, no args)', last: {} },
    { label: 'last: { endedAt: null }', last: { endedAt: null } },
    { label: 'last: { endedAt, args: undefined }', last: { endedAt: validEndedAt, args: undefined } },
    { label: 'last: { endedAt, args: {} } (no text)', last: { endedAt: validEndedAt, args: {} } }
  ]

  for (const c of cases) {
    let result: unknown
    assert.doesNotThrow(() => {
      result = findFinishedMatch(queued, c.last as FinishedPasteJob | null)
    }, c.label)
    assert.equal(result, null, c.label)
  }
})
