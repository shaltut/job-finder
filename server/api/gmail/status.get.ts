import { readConfigRaw } from '../../utils/config'
import { gmailStatus } from '../../utils/gmail'

export default defineEventHandler(() => {
  const cfg = readConfigRaw() as { profile?: { email?: string } }
  return gmailStatus(cfg.profile?.email ?? null)
})
