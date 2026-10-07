import { sqlite } from '../../utils/db'
import { unreadCount } from '../../utils/inbox-store'

/** The sidebar badge polls this every minute: a local count, never a Gmail call. */
export default defineEventHandler(() => ({ unread: unreadCount(sqlite) }))
