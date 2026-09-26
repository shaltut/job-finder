import { basename } from 'node:path'
import { backup } from '../utils/backup'
import { DB_PATH } from '../utils/db'
import { readConfigLoose } from '../utils/config'
import { gmailStatus } from '../utils/gmail'
import { enqueue, notify } from '../utils/jobs'

/**
 * Daily housekeeping. Runs only while the dev server is up — nothing happens when it is down, same as the
 * original's `dailyTick`. The sweep is *enqueued* rather than run inline so it shares the draft lane and
 * cannot collide with a drafter session.
 */
export default defineTask({
  meta: { name: 'daily', description: 'Gmail stage sweep and a dated database backup' },
  run() {
    const messages: string[] = []

    try {
      const { file, pruned } = backup(DB_PATH)
      messages.push(`backup ${basename(file)}${pruned.length ? `, pruned ${pruned.length}` : ''}`)
    } catch (e) {
      messages.push(`backup failed: ${(e as Error).message}`)
    }

    // follow-ups only fire if the sweep runs, so this is what makes them automatic
    try {
      // loose, not readConfig(): an incomplete config must not cost us the nightly backup, and the
      // sweep has no use for the fields a scrape needs
      const email = readConfigLoose().profile.email
      if (!email) {
        messages.push('sweep skipped: no profile email set')
      } else if (gmailStatus(email).authorized) {
        enqueue('sync', { auto: true })
        messages.push('sweep queued')
      } else {
        messages.push('sweep skipped: gmail not connected')
      }
    } catch (e) {
      messages.push(`sweep not queued: ${(e as Error).message}`)
    }

    // A newly uploaded CV makes every gap record stale; this re-reads them without anyone remembering.
    // Costs nothing when nothing is pending: the master CV is cached and the selection comes back empty.
    try {
      enqueue('gaps', { auto: true })
      messages.push('gaps queued')
    } catch (e) {
      messages.push(`gaps not queued: ${(e as Error).message}`)
    }

    const summary = messages.join('; ')
    console.log(`[daily] ${summary}`)
    notify(`daily: ${summary}`)
    return { result: summary }
  }
})
