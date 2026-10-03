// The job queue's decisions, kept out of server/utils/jobs.ts (which no test can import: it pulls in
// the drafter, Gmail, sync and the CV modules). See docs/superpowers/specs/2026-10-03-job-queue-design.md.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { concurrency, draftPriority, pickNext, pool, restorePlan, resumedArgs, shouldRestore, withRetry, type QItem } from '../server/utils/queue-core.ts'

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

test('restore: never after a hand-off pull or while the other machine is active', () => {
  assert.equal(shouldRestore({ pulled: false, otherActive: false }), true)
  assert.equal(shouldRestore({ pulled: true, otherActive: false }), false, 'the rows are the other machine\'s')
  assert.equal(shouldRestore({ pulled: false, otherActive: true }), false)
})

test('a resumed draft is marked so it writes no skip rows', () => {
  assert.deepEqual(resumedArgs('draft', { n: 10 } as QItem['args'], true), { n: 10, resumed: true })
  assert.deepEqual(resumedArgs('draft', { key: 'a' }, false), { key: 'a' }, 'never started: an ordinary run')
  assert.deepEqual(resumedArgs('gaps', {}, true), {}, 'only drafts write skips')
})
