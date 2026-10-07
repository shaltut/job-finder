// The job queue's decisions, kept out of server/utils/jobs.ts (which no test can import: it pulls in
// the drafter, Gmail, sync and the CV modules). See docs/superpowers/specs/2026-10-03-job-queue-design.md.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backoff, concurrency, draftPriority, limiter, mergeReply, pickNext, pool, restorePlan, resumedArgs, samePaste, shouldRestore, withRetry, type QItem } from '../server/utils/queue-core.ts'

const item = (id: number, kind: string, args: QItem['args'] = {}, lane: QItem['lane'] = 'draft'): QItem =>
  ({ id, lane, kind, args, queuedAt: '' })

test('draft-lane priority: hand-picked, then sync, then bulk; FIFO within a priority', () => {
  assert.equal(draftPriority(item(1, 'draft', { key: 'a' })), 0)
  assert.equal(draftPriority(item(1, 'draft', { keys: ['a'] })), 0, 'keys without screened are hand-picked')
  assert.equal(draftPriority(item(1, 'sync')), 1)
  assert.equal(draftPriority(item(1, 'draft', { keys: ['a'], screened: true })), 2)
  assert.equal(draftPriority(item(1, 'draft', { n: 10 } as QItem['args'])), 2)

  const q = [item(1, 'draft', { n: 10 } as QItem['args']), item(2, 'sync'), item(3, 'scrape', {}, 'scrape'), item(4, 'draft', { key: 'x' }), item(5, 'draft', { key: 'y' })]
  assert.equal(q[pickNext(q, 'draft')]!.id, 4, 'the earliest hand-picked draft jumps the bulk run and the sync')
  assert.equal(q[pickNext(q, 'scrape')]!.id, 3)
  assert.equal(pickNext(q, 'gaps'), -1)
  const noHand = [item(1, 'draft', { n: 10 } as QItem['args']), item(2, 'sync')]
  assert.equal(noHand[pickNext(noHand, 'draft')]!.id, 2)
  const gaps = [item(7, 'gaps', {}, 'gaps'), item(8, 'gaps', {}, 'gaps')]
  assert.equal(gaps[pickNext(gaps, 'gaps')]!.id, 7, 'other lanes are plain FIFO')
})

test('restore: interrupted scrape-lane jobs are dropped, the rest go back to the front in order', () => {
  const plan = restorePlan([
    { id: 3, lane: 'draft', kind: 'draft', started: false },
    { id: 9, lane: 'scrape', kind: 'scrape', started: true },
    { id: 7, lane: 'draft', kind: 'draft', started: true },
    { id: 8, lane: 'gaps', kind: 'gaps', started: true },
    { id: 11, lane: 'scrape', kind: 'reflag', started: false }
  ])
  assert.deepEqual(plan.drop, [9])
  assert.deepEqual(plan.order, [7, 8, 3, 11], 'interrupted first (by id), then the waiting ones (by id)')
  assert.equal(plan.seq, 11)
  assert.deepEqual(restorePlan([]), { drop: [], order: [], seq: 0 })
})

test('pool: never more than n in flight, every item done, nothing new after abort', async () => {
  let inFlight = 0
  let peak = 0
  const done: number[] = []
  await pool([1, 2, 3, 4, 5], 2, async (i) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 5))
    done.push(i)
    inFlight--
  })
  assert.equal(peak, 2)
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5])

  const ac = new AbortController()
  const started: number[] = []
  await pool([1, 2, 3, 4, 5], 2, async (i) => {
    started.push(i)
    if (i === 1) ac.abort()
    await new Promise(r => setTimeout(r, 5))
  }, ac.signal)
  assert.ok(started.length <= 2, `started ${started.join(',')} after an abort`)
})

test('withRetry: one retry, none on abort, the second failure surfaces', async () => {
  let calls = 0
  const retried: string[] = []
  assert.equal(await withRetry(async () => {
    if (++calls === 1) throw new Error('timeout')
    return 'ok'
  }, { waitMs: 0, onRetry: e => retried.push(e.message) }), 'ok')
  assert.deepEqual(retried, ['timeout'])

  calls = 0
  await assert.rejects(withRetry(async () => {
    calls++
    throw new Error(`fail ${calls}`)
  }, { waitMs: 0 }), /fail 2/)
  assert.equal(calls, 2)

  const ac = new AbortController()
  ac.abort()
  calls = 0
  await assert.rejects(withRetry(async () => {
    calls++
    throw new Error('aborted')
  }, { waitMs: 0, signal: ac.signal }))
  assert.equal(calls, 1, 'a stopped job is not retried')
})

test('concurrency: default 2, clamped 1-4', () => {
  assert.equal(concurrency(undefined), 2)
  assert.equal(concurrency(''), 2)
  assert.equal(concurrency('3'), 3)
  assert.equal(concurrency('0'), 1)
  assert.equal(concurrency('9'), 4)
  assert.equal(concurrency('abc'), 2)
})

test('withRetry: Stop during the back-off ends it at once', async () => {
  const ac = new AbortController()
  const t0 = Date.now()
  const p = withRetry(async () => {
    throw new Error('timeout')
  }, { waitMs: 5_000, signal: ac.signal })
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(p)
  assert.ok(Date.now() - t0 < 1_000, `took ${Date.now() - t0}ms`)
})

test('restore: never after a hand-off pull — those rows are the other machine\'s', () => {
  assert.equal(shouldRestore({ pulled: true }), false)
})

test('a resumed draft is marked so it writes no skip rows', () => {
  assert.deepEqual(resumedArgs('draft', { n: 10 } as QItem['args'], true), { n: 10, resumed: true })
  assert.deepEqual(resumedArgs('draft', { key: 'a' }, false), { key: 'a' }, 'never started: an ordinary run')
  assert.deepEqual(resumedArgs('gaps', {}, true), {}, 'only drafts write skips')
})

// In-flight items finish; nothing new starts after a failure — the old sequential loop also ended the job
// on an uncaught throw.
test('pool: one item failing never cuts the others short — they finish, then the failure surfaces', async () => {
  const finished: number[] = []
  await assert.rejects(pool([1, 2, 3], 2, async (i) => {
    if (i === 1) throw new Error('gmail down')
    await new Promise(r => setTimeout(r, 20))
    finished.push(i)
  }), /gmail down/)
  assert.deepEqual(finished, [2], 'the in-flight group finished before the pool returned; 3 never started')
})

test('restore: this machine\'s own queue survives the other machine merely being active', () => {
  assert.equal(shouldRestore({ pulled: false }), true)
  assert.equal(shouldRestore({ pulled: true }), false)
})

test('withRetry: a failure that cannot pass a second time is not retried', async () => {
  for (const msg of ['could not start claude: spawn ENOENT', 'claude exited 1: You have reached your usage limit', 'Claude AI usage limit reached']) {
    let calls = 0
    await assert.rejects(withRetry(async () => {
      calls++
      throw new Error(msg)
    }, { waitMs: 0 }))
    assert.equal(calls, 1, msg)
  }
})

test('limiter: never more than n calls in flight, results in call order', async () => {
  const run = limiter(2)
  let inFlight = 0
  let peak = 0
  const out = await Promise.all([1, 2, 3, 4, 5].map(i => run(async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 5 * (6 - i)))
    inFlight--
    return i * 10
  })))
  assert.equal(peak, 2)
  assert.deepEqual(out, [10, 20, 30, 40, 50])
  await assert.rejects(run(async () => {
    throw new Error('boom')
  }), /boom/)
  assert.equal(await run(async () => 'still works after a failure'), 'still works after a failure')
})

test('limiter: calls start at least minGapMs apart — a rate, not only a concurrency cap', async () => {
  // Gmail's quota is per minute; six fast calls in flight still made ~120 calls/s and tripped it (2026-10-04)
  const run = limiter(6, 20)
  const starts: number[] = []
  await Promise.all([1, 2, 3, 4, 5].map(() => run(async () => {
    starts.push(Date.now())
  })))
  // the rate is what a per-minute quota counts; one gap can jitter by a Windows timer tick (~15ms)
  const span = starts.at(-1)! - starts[0]!
  assert.ok(span >= 4 * 20 - 10, `5 calls spanned ${span}ms, want ≥ 70`)
})

test('backoff: retries a quota error after waiting, rethrows anything else at once', async () => {
  const quota = Object.assign(new Error('gmail drafts: Quota exceeded for quota metric \'Total Query Cost\''), { statusCode: 429 })
  let calls = 0
  const waited: number[] = []
  const ok = await backoff(async () => {
    if (++calls < 3) throw quota
    return 'done'
  }, { waits: [1, 2, 3], sleep: async (ms) => { waited.push(ms) } })
  assert.equal(ok, 'done')
  assert.deepEqual(waited, [1, 2])

  calls = 0
  await assert.rejects(backoff(async () => {
    calls++
    throw new Error('gmail messages: Not Found')
  }, { waits: [1], sleep: async () => {} }), /Not Found/)
  assert.equal(calls, 1)

  calls = 0
  await assert.rejects(backoff(async () => {
    calls++
    throw quota
  }, { waits: [1, 2], sleep: async () => {} }), /Quota exceeded/)
  assert.equal(calls, 3, 'gives up after the last wait')
})

test('two paste requests are the same job only when text AND author match (review 2026-10-04)', () => {
  assert.equal(samePaste({ text: 'a' }, { text: 'a' }), true)
  assert.equal(samePaste({ text: 'a' }, { text: 'a', authorUrl: 'https://www.linkedin.com/in/x' }), false, 'a paste then a clip')
  assert.equal(samePaste({ text: 'a', authorUrl: 'u1' }, { text: 'a', authorUrl: 'u2' }), false, 'one template, two authors')
  assert.equal(samePaste({ text: 'a', authorUrl: 'u1' }, { text: 'a', authorUrl: 'u1' }), true)
})

test('restore: an interrupted sender is never resumed — only the owner\'s button starts sending (review 2026-10-05)', () => {
  const plan = restorePlan([{ id: 4, lane: 'send', kind: 'send', started: true }, { id: 5, lane: 'draft', kind: 'draft', started: true }])
  assert.deepEqual(plan.drop, [4])
  assert.deepEqual(plan.order, [5])
})

test('reply jobs: a pressed Re-draft is hand-picked, an automatic one is background', () => {
  assert.equal(draftPriority(item(1, 'reply', { messageId: 'm', threadId: 't', manual: true })), 0)
  assert.equal(draftPriority(item(1, 'reply', { messageId: 'm', threadId: 't' })), 2)
})

test('a newer message in the thread replaces the queued reply, keeping a pressed note', () => {
  assert.deepEqual(mergeReply([], { messageId: 'm2', threadId: 't' }), { messageId: 'm2', threadId: 't' })
  assert.deepEqual(
    mergeReply([{ messageId: 'm1', threadId: 't', manual: true, note: 'say Tuesday' }], { messageId: 'm2', threadId: 't' }),
    { messageId: 'm2', threadId: 't', manual: true, note: 'say Tuesday' }
  )
  assert.deepEqual(
    mergeReply([{ messageId: 'm1', threadId: 't', manual: true, note: 'old' }], { messageId: 'm1', threadId: 't', manual: true, note: 'new' }),
    { messageId: 'm1', threadId: 't', manual: true, note: 'new' },
    'a second press wins over the first'
  )
})
