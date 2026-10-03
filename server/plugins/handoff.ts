// Pushes a snapshot every 2 minutes when anything committed to the database (changeSig in db.ts).
// ponytail: whole-file snapshot (~8 MB); switch to session changesets if the DB passes ~100 MB.
import { changeSig } from '../utils/db'
import { beat, handoffState, pushNow } from '../utils/handoff-runtime'

const EVERY_MS = 2 * 60_000

export default defineNitroPlugin((nitro) => {
  if (!handoffState().enabled) return
  // The baseline ("no change since boot") is taken at the end of migrate.ts, after every boot-time write:
  // plugins run in file-name order, so taking it here would count the migrations and the queue restore
  // as changes and push an unchanged — possibly stale — copy two minutes after boot.
  const timer = setInterval(() => {
    const sig = changeSig()
    if (sig !== handoffState().lastSig) pushNow(sig)
    else beat()
  }, EVERY_MS)
  nitro.hooks.hook('close', () => clearInterval(timer))
})
