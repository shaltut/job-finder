// Refuses a write from any other site (see server/utils/origin.ts for who may write, and why).
// A new server/middleware/ file is picked up only when `npm run dev` starts — not on a hot reload.
import { originAllowed } from '../utils/origin'

export default defineEventHandler((event) => {
  if (!originAllowed(event.method, getRequestHeader(event, 'origin'))) {
    throw createError({ statusCode: 403, statusMessage: 'cross-site write refused' })
  }
})
