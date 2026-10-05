// The job queue's decisions, pure, so test/queue.test.ts can reach them — server/utils/jobs.ts cannot be
// imported by a test (it pulls in the drafter, Gmail, sync and the CV modules).
// See docs/superpowers/specs/2026-10-03-job-queue-design.md.

export type Lane = 'scrape' | 'draft' | 'paste' | 'gaps' | 'send'

export interface QArgs { key?: string, keys?: string[], screened?: boolean }
export interface QItem { id: number, lane: Lane, kind: string, args: QArgs, queuedAt: string }

/**
 * The draft lane's order. A post the owner hand-picked is a person waiting at the screen; the Gmail sync
 * is the follow-up clock; a bulk or batch run is the background. Within a priority, FIFO.
 */
export function draftPriority(i: QItem): 0 | 1 | 2 {
  if (i.kind === 'sync') return 1
  if (i.kind === 'draft' && (i.args.key || (i.args.keys?.length && !i.args.screened))) return 0
  return 2
}

/** Index in `queue` of the item `lane` should run next, or -1. Other lanes are plain FIFO. */
export function pickNext(queue: QItem[], lane: Lane): number {
  let best = -1
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i]!
    if (q.lane !== lane) continue
    if (lane !== 'draft') return i
    if (best < 0 || draftPriority(q) < draftPriority(queue[best]!)) best = i
  }
  return best
}

/**
 * Never resumed after a restart. The scrape kinds drive LinkedIn: re-running one on every server edit spends
 * the account's rate limit. `send` sends email: only the owner's button starts it — resuming would fire an
 * unpaced batch on every server edit and start sending on a plain `npm run dev` the next day.
 */
const SCRAPE_KINDS = new Set(['scrape', 'rescore', 'reflag', 'reextract', 'send'])

/**
 * What a fresh worker does with the persisted queue. Jobs that were running when the old worker died go
 * first (they were already at the head of their lane), then the waiting ones, each in id order;
 * interrupted scrape-lane jobs are dropped. `seq` keeps new ids above every restored one.
 */
export function restorePlan(rows: { id: number, lane: Lane, kind: string, started: boolean }[]): { drop: number[], order: number[], seq: number } {
  const byId = [...rows].sort((a, b) => a.id - b.id)
  const drop = byId.filter(r => r.started && SCRAPE_KINDS.has(r.kind)).map(r => r.id)
  const order = [
    ...byId.filter(r => r.started && !SCRAPE_KINDS.has(r.kind)),
    ...byId.filter(r => !r.started)
  ].map(r => r.id)
  return { drop, order, seq: byId.at(-1)?.id ?? 0 }
}

/**
 * Runs `fn` over `items`, at most `n` at a time. After `signal` aborts, no new item starts. A failing item
 * never cuts the others short: every worker settles first, then the first failure is rethrown — the caller
 * closes the database and the CV browser when this returns, and a recruiter still between createDraft and
 * persist() would otherwise lose its row.
 */
export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  let failed: { error: unknown } | null = null
  const worker = async () => {
    while (next < items.length && !signal?.aborted && !failed) {
      try {
        await fn(items[next++]!)
      } catch (error) {
        failed ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  if (failed) throw (failed as { error: unknown }).error
}

/**
 * At most `n` calls of the returned function in flight; the rest wait their turn. For an API with a rate
 * quota shared by many callers (Gmail: ~250 units/s per user, a message read costs 5), where pool() — one
 * list, one loop — cannot see the calls nested inside each item.
 */
export function limiter(n: number, minGapMs = 0) {
  let active = 0
  let nextStart = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>(r => waiting.push(r))
    active++
    // A rate as well as a cap: fast calls under a concurrency cap alone still run as fast as they return.
    // Measured 2026-10-04: limiter(6) with no gap tripped Gmail's per-minute quota on the first sync.
    const wait = nextStart - Date.now()
    nextStart = Math.max(Date.now(), nextStart) + minGapMs
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** A rate-limit refusal: HTTP 429, or Google's "Quota exceeded" / "rateLimitExceeded" wording. */
const RATE_LIMITED = /quota exceeded|rate ?limit/i

/**
 * Retries `fn` after each of `waits` when it fails with a rate-limit error; anything else is rethrown at
 * once. Gmail's quota is per minute, so waiting is the cure, not trying again sooner.
 */
export async function backoff<T>(fn: () => Promise<T>, o: { waits?: number[], sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const waits = o.waits ?? [15_000, 30_000, 60_000]
  const sleep = o.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const err = e as Error & { statusCode?: number }
      if (i >= waits.length || !(err.statusCode === 429 || RATE_LIMITED.test(err.message ?? ''))) throw e
      await sleep(waits[i]!)
    }
  }
}

/** Failures a second try cannot fix: claude would not start, or the plan's usage limit is spent. */
const PERMANENT = /could not start claude|usage limit/i

/**
 * One retry after `waitMs`. Not after an abort: Stop means stop. The second failure is the one that
 * surfaces, so the log says what happened last.
 */
export async function withRetry<T>(fn: () => Promise<T>, o: { signal?: AbortSignal, waitMs?: number, onRetry?: (e: Error) => void } = {}): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (o.signal?.aborted || PERMANENT.test((e as Error).message ?? '')) throw e
    o.onRetry?.(e as Error)
    // the back-off ends early on Stop, so Stop never waits out the 10s
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, o.waitMs ?? 10_000)
      o.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      }, { once: true })
    })
    if (o.signal?.aborted) throw e
    return await fn()
  }
}

/**
 * One paste job or two: the same text from the same author. Text alone merged a paste with a later clip
 * of it (losing the clip's author) and two clips of one template from different recruiters.
 */
export const samePaste = (a: { text?: string, authorUrl?: string }, b: { text?: string, authorUrl?: string }) =>
  a.text === b.text && (a.authorUrl ?? '') === (b.authorUrl ?? '')

/**
 * Whether a fresh worker resumes the persisted queue. Not after a hand-off pull: those rows are the other
 * machine's, and it may have finished them after its last push (or still be running them) — resuming would
 * draft the same recruiters twice. Without a pull the rows are this machine's own, whatever the other
 * machine is doing.
 */
export const shouldRestore = (o: { pulled: boolean }) => !o.pulled

/**
 * A draft that was running when its worker died is marked `resumed`: it may have been cut down inside
 * createDraft, so the Gmail gate would now see its own pending draft and write `skipped` over posts that
 * draft names — losing the `named in application` prefix the follow-up depends on. A resumed run writes
 * no skip rows, exactly like a hand-picked one.
 */
export function resumedArgs<A extends QArgs>(kind: string, args: A, started: boolean): A & { resumed?: true } {
  return kind === 'draft' && started ? { ...args, resumed: true } : args
}

/** JOBFINDER_DRAFT_CONCURRENCY: default 2 — a higher value can meet the Claude plan's rate limit. */
export function concurrency(env: string | undefined): number {
  const n = Number.parseInt(env ?? '', 10)
  return Number.isFinite(n) ? Math.min(4, Math.max(1, n)) : 2
}
