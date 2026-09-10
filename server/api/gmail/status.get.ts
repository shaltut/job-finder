import { readConfigRaw } from '../../utils/config'
import { gmailStatus } from '../../utils/gmail'

export default defineEventHandler(() => {
  const cfg = readConfigRaw() as { profile?: { email?: string } }
  // a fresh install stores '' rather than undefined, and ?? would pass that straight through —
  // the mismatch banner would then fire against an empty expected address
  return gmailStatus(cfg.profile?.email || null)
})
