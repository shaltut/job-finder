import { authUrl } from '../../utils/gmail'

/** Redirects to Google's consent screen, minting the one-shot state nonce on the way. */
export default defineEventHandler(async (event) => {
  await sendRedirect(event, authUrl(), 302)
})
