import type { JobState } from '~/types'

/**
 * Queue a re-flag and wait for it to actually finish.
 *
 * POST /api/run/reflag returns 202 and only *queues* the job, and jobs.ts puts `reflag` on the scrape
 * lane — the same lane Chrome holds. So refreshing the moment the POST resolves shows stale rows, and
 * if a scrape is already running the wait is genuinely long rather than a few hundred milliseconds.
 * Every caller wants the same three things: queue it, wait, then report how many posts are excluded.
 *
 * Polls at the same 1500ms cadence the Run view uses. `onQueued` fires when the job is stuck behind a
 * scrape, so the caller can say so instead of looking hung.
 *
 * Callers must treat a throw from here as "the re-check did not run", never as "the write failed" —
 * by the time this is called the settings row is already saved.
 */
export function useReflag() {
  async function reflagAndWait(opts: { onQueued?: () => void } = {}): Promise<{ posts: number, excluded: number }> {
    const started = await $fetch<JobState>('/api/run/reflag', { method: 'POST' })
    // Still in the queue means it is waiting behind something — the unambiguous test. runJob assigns
    // lanes[lane].current synchronously, so on the fast path our job is already current, not queued.
    if (started.queue.some(q => q.kind === 'reflag')) opts.onQueued?.()

    // Stop when the scrape lane is idle AND nothing of ours is left queued. Checking only the lane
    // would return immediately while our job is still sitting in the queue behind a scrape.
    for (let i = 0; i < 1600; i++) { // ~40 min ceiling, long enough to outlast a full scrape
      await new Promise(r => setTimeout(r, 1500))
      const s = await $fetch<JobState>('/api/job')
      if (s.queue.some(q => q.kind === 'reflag') || s.lanes.scrape.current?.kind === 'reflag') continue

      const last = s.lanes.scrape.last
      if (last?.kind === 'reflag') return { posts: last.added, excluded: last.excluded ?? 0 }
      return { posts: 0, excluded: 0 } // finished and rotated out of `last`; the refresh still stands
    }
    return { posts: 0, excluded: 0 }
  }

  return { reflagAndWait }
}
