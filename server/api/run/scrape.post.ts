import { z } from 'zod'
import { enqueue, stateView } from '../../utils/jobs'

const body = z.object({
  terms: z.string().trim().min(1).max(500).optional(),
  max: z.coerce.number().int().min(1).max(200).optional(),
  since: z.enum(['past-24h', 'past-week', 'past-month']).optional()
})

export default defineEventHandler(async (event) => {
  const args = await readValidatedBody(event, body.parse)
  enqueue('scrape', args)
  setResponseStatus(event, 202)
  return stateView()
})
