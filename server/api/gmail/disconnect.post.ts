import { disconnect, gmailStatus } from '../../utils/gmail'

export default defineEventHandler(() => {
  disconnect()
  return gmailStatus()
})
