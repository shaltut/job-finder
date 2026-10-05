import { enqueue, stateView } from '../../utils/jobs'

/**
 * Starts the sender lane: up to 10 of the app's own pending drafts every 15 minutes until none are left
 * (server/utils/sender.ts). Only ever from this button — nothing schedules it.
 */
export default defineEventHandler((event) => {
  const item = enqueue('send')
  setResponseStatus(event, item ? 202 : 200)
  return { ...stateView(), queued: !!item, note: item ? undefined : 'the sender is already running' }
})
