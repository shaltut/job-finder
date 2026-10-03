import { z } from 'zod'
import { stateView, stopLane } from '../../utils/jobs'

const body = z.object({ lane: z.enum(['scrape', 'draft', 'gaps']).default('draft') })

export default defineEventHandler(async (event) => {
  const { lane } = await readValidatedBody(event, body.parse)
  if (!stopLane(lane)) throw createError({ statusCode: 409, message: `nothing running in the ${lane} lane` })
  return stateView()
})
