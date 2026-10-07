import { readConfigLoose } from '../utils/config'
import { gmailStatus } from '../utils/gmail'
import { pollInbox } from '../utils/inbox'
import { openWritableDb } from '../utils/ingest'
import { enqueue } from '../utils/jobs'

// on globalThis like the job runner: a dev rebuild must not let two polls overlap on a slow backfill
const g = globalThis as { __jobfinderInboxPolling?: boolean }

/** Every 5 minutes while the server runs: new replies into the inbox, and a reply draft queued for each thread. */
export default defineTask({
  meta: { name: 'inbox', description: 'Poll Gmail for replies in threads the owner started' },
  async run() {
    if (g.__jobfinderInboxPolling) return { result: 'skipped: a poll is still running' }
    const status = gmailStatus(readConfigLoose().profile.email || null)
    if (!status.authorized || !status.email) return { result: 'skipped: gmail not connected' }
    g.__jobfinderInboxPolling = true
    const { db, close } = openWritableDb()
    try {
      const { stored, toDraft } = await pollInbox(db, status.email.toLowerCase(), console.log)
      for (const t of toDraft) enqueue('reply', { messageId: t.messageId, threadId: t.threadId, auto: true })
      return { result: `${stored} new repl(ies), ${toDraft.length} draft(s) queued` }
    } catch (e) {
      console.log(`[inbox] poll failed: ${(e as Error).message}`)
      return { result: `failed: ${(e as Error).message}` }
    } finally {
      close()
      g.__jobfinderInboxPolling = false
    }
  }
})
