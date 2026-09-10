import { consumeAuthState, exchangeCode } from '../../utils/gmail'

/**
 * Google's redirect lands here. This is a CROSS-SITE GET, so no Origin / Sec-Fetch-Site guard can cover it:
 * without the state nonce any page open in the browser could hand us its own authorization code and have the
 * drafts written into its mailbox. Ported from upstream e8be7b6 — see CLAUDE.md.
 */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)

  // check the nonce BEFORE touching the code, and consume it either way so a replay fails too
  const stateOk = consumeAuthState(typeof q.state === 'string' ? q.state : undefined)
  if (!stateOk) {
    throw createError({ statusCode: 400, message: 'state mismatch: start from Connect Gmail in the Pipeline view' })
  }

  if (typeof q.code !== 'string' || !q.code) {
    throw createError({ statusCode: 400, message: `google returned: ${q.error || 'no code'}` })
  }

  const token = await exchangeCode(q.code)
  return sendRedirect(event, `/pipeline?connected=${encodeURIComponent(token.email ?? '')}`, 302)
})
