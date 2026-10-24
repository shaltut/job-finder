// Every 30 s: one step of the lease between the two machines (server/utils/handoff.ts nextStep) and this
// machine's heartbeat. The leader pushes a snapshot at most every 2 minutes, when anything committed to the
// database (changeSig in db.ts).
// ponytail: whole-file snapshot (~8 MB); switch to session changesets if the DB passes ~100 MB.
import { changeSig, sqlite } from '../utils/db'
import { busy, yieldAll } from '../utils/jobs'
import { handoffState, tick } from '../utils/handoff-runtime'

const TICK_MS = 30_000
const PUSH_MS = 2 * 60_000

export default defineNitroPlugin((nitro) => {
  if (!handoffState().enabled) return
  // The baseline ("no change since boot") is taken at the end of migrate.ts, after every boot-time write:
  // plugins run in file-name order, so taking it here would count the migrations and the queue restore
  // as changes and push an unchanged — possibly stale — copy two minutes after boot.
  let lastPushTry = Date.now()
  const timer = setInterval(() => {
    const pushDue = Date.now() - lastPushTry >= PUSH_MS
    if (pushDue) lastPushTry = Date.now()
    try {
      tick({ live: sqlite, sig: changeSig, busy, stopAll: yieldAll, pushDue })
    } catch (e) {
      console.error(`[sync] tick failed: ${(e as Error).message}`)
    }
  }, TICK_MS)
  nitro.hooks.hook('close', () => clearInterval(timer))
})
