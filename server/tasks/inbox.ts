import { readConfigLoose } from '../utils/config'
import { gmailStatus } from '../utils/gmail'
import { pollInbox } from '../utils/inbox'
import { openWritableDb } from '../utils/ingest'
import { strandedQueued } from '../utils/inbox-store'
import { enqueue } from '../utils/jobs'

// on globalThis so a module reload inside one worker cannot start a second poll over a slow backfill;
// it cannot see across a Nitro worker rebuild (globalThis is per worker)
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
      // threads a dead poll or a rebuild left `queued` with no job; enqueue() ignores one already running
      for (const t of strandedQueued(db)) enqueue('reply', { ...t, auto: true })
      const { stored, threads } = await pollInbox(db, status.email.toLowerCase(), console.log, t => enqueue('reply', { ...t, auto: true }))
      return { result: `${stored} new repl(ies), ${threads} draft(s) queued` }
    } catch (e) {
      console.log(`[inbox] poll failed: ${(e as Error).message}`)
      return { result: `failed: ${(e as Error).message}` }
    } finally {
      close()
      g.__jobfinderInboxPolling = false
    }
  }
})
