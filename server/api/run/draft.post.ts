import { z } from 'zod'
import { enqueue, stateView } from '../../utils/jobs'

const body = z.object({
  // a single post (the Posts view's Draft button), a bulk selection, or the top N unprocessed
  key: z.string().regex(/^[0-9a-f]{40}$/, 'key must be a sha1').optional(),
  keys: z.array(z.string().regex(/^[0-9a-f]{40}$/, 'key must be a sha1')).min(1).max(100).optional(),
  n: z.number().int().min(1).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)
  // a bulk selection is always screened: hand-picked bulk is not a mode the UI offers
  const item = enqueue('draft', a.keys ? { keys: a.keys, screened: true } : a.key ? { key: a.key } : { n: a.n ?? 10 })
  setResponseStatus(event, item ? 202 : 200)
  // a repeat request for posts already queued or running is a no-op, not a second session
  return { ...stateView(), queued: !!item, note: item ? undefined : 'already queued or running' }
})
