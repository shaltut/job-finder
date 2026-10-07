/**
 * The Inbox's Sync button: the 5-minute poll, now. runTask() returns the run already in flight when the
 * timer got there first, so a press never starts a second poll beside it.
 */
export default defineEventHandler(async () => {
  const { result } = await runTask('inbox')
  return { result: String(result ?? '') }
})
