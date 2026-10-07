import { sqlite } from '../../utils/db'
import { markRead } from '../../utils/inbox-store'

export default defineEventHandler(async (event) => {
  const { messageId } = await readBody<{ messageId?: string }>(event)
  if (!messageId) throw createError({ statusCode: 400, message: 'messageId is required' })
  markRead(sqlite, messageId)
  return { ok: true }
})
