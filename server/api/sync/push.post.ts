import { changeSig } from '../../utils/db'
import { pushNow } from '../../utils/handoff-runtime'

// `init: true` seeds an empty sync folder — only ever from the button, never from the timer
export default defineEventHandler(async (event) => {
  const body = await readBody<{ init?: boolean } | undefined>(event).catch(() => undefined)
  return pushNow(changeSig(), body?.init === true)
})
