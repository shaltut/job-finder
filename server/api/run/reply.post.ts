import { sqlite } from '../../utils/db'
import { inboxRow, markReply } from '../../utils/inbox-store'
import { enqueue, stateView } from '../../utils/jobs'

/** Re-draft from the Inbox: hand-picked priority, with the owner's note. */
export default defineEventHandler(async (event) => {
  const { messageId, note } = await readBody<{ messageId?: string, note?: string }>(event)
  const row = messageId ? inboxRow(sqlite, messageId) : undefined
  if (!row) throw createError({ statusCode: 404, message: 'no such inbox message' })
  const item = enqueue('reply', { messageId: row.message_id, threadId: row.thread_id, note: note?.trim() || undefined, manual: true })
  if (item) markReply(sqlite, row.message_id, 'queued')
  setResponseStatus(event, item ? 202 : 200)
  return { ...stateView(), queued: !!item }
})
