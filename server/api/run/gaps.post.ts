import { enqueue, stateView } from '../../utils/jobs'

/**
 * The gap record's catch-up job: reads every application not yet read against the current CV. The same
 * job is the backfill, the post-draft trigger and the daily one, because selection is idempotent.
 */
export default defineEventHandler((event) => {
  const item = enqueue('gaps')
  setResponseStatus(event, item ? 202 : 200)
  return { ...stateView(), queued: !!item, note: item ? undefined : 'a gaps run is already queued' }
})
