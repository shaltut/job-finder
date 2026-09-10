import { z } from 'zod'
import { enqueue, stateView } from '../../utils/jobs'

const body = z.object({
  // a single post (the Posts view's Draft button), or the top N unprocessed
  key: z.string().regex(/^[0-9a-f]{40}$/, 'key must be a sha1').optional(),
  n: z.number().int().min(1).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)
  const item = enqueue('draft', a.key ? { key: a.key } : { n: a.n ?? 10 })
  setResponseStatus(event, item ? 202 : 200)
  // a repeat request for a post already queued or running is a no-op, not a second session
  return { ...stateView(), queued: !!item, note: item ? undefined : 'already queued or running' }
})
