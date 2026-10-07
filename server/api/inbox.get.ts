import { sqlite } from '../utils/db'
import { listInbox } from '../utils/inbox-store'

export default defineEventHandler(() => listInbox(sqlite).map(r => ({
  ...r,
  questions: r.questions ? JSON.parse(r.questions) as string[] : []
})))
