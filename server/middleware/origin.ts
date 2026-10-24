// Refuses a request for another host name (DNS rebinding) and a write from any other site — see
// server/utils/origin.ts for who may do what, and why.
// A new server/middleware/ file is picked up only when `npm run dev` starts — not on a hot reload.
import { hostAllowed, originAllowed } from '../utils/origin'
import { standbyRefuses } from '../utils/handoff'
import { handoffState, currentRole } from '../utils/handoff-runtime'

export default defineEventHandler((event) => {
  if (!hostAllowed(getRequestHeader(event, 'host'))) {
    throw createError({ statusCode: 403, statusMessage: 'unknown host' })
  }
  if (!originAllowed(event.method, getRequestHeader(event, 'origin'))) {
    throw createError({ statusCode: 403, statusMessage: 'cross-site write refused' })
  }
  // standby: the other machine leads, and the next live pull would overwrite anything written here
  if (standbyRefuses(currentRole(), event.method, event.path)) {
    const s = handoffState()
    throw createError({ statusCode: 409, statusMessage: `this machine is on standby${s.peer ? ` — ${s.peer.host} is leading` : ''}; press Use this machine to take over` })
  }
})
