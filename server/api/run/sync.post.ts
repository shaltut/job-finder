import { enqueue, stateView } from '../../utils/jobs'

/** The Gmail stage sweep. Enqueued, never run inline: it shares the draft lane with claude sessions. */
export default defineEventHandler((event) => {
  const item = enqueue('sync')
  setResponseStatus(event, item ? 202 : 200)
  return { ...stateView(), queued: !!item, note: item ? undefined : 'a sync is already queued or running' }
})
