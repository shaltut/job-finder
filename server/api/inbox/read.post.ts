import { sqlite } from '../../utils/db'
import { markAllRead, markRead } from '../../utils/inbox-store'

/** `{ messageId }` marks one message read; `{ all: true }` is the Inbox's Mark all read. */
export default defineEventHandler(async (event) => {
  const { messageId, all } = (await readBody<{ messageId?: unknown, all?: unknown }>(event)) ?? {}
  if (all === true) {
    markAllRead(sqlite)
    return { ok: true }
  }
  if (typeof messageId !== 'string' || !messageId) throw createError({ statusCode: 400, message: 'messageId is required' })
  markRead(sqlite, messageId)
  return { ok: true }
})
