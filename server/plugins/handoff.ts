// Pushes a snapshot every 2 minutes when anything committed to the database (changeSig in db.ts).
// ponytail: whole-file snapshot (~8 MB); switch to session changesets if the DB passes ~100 MB.
import { changeSig } from '../utils/db'
import { beat, handoffState, pushNow } from '../utils/handoff-runtime'

const EVERY_MS = 2 * 60_000

export default defineNitroPlugin((nitro) => {
  if (!handoffState().enabled) return
  // the baseline is "now", not empty: a machine that booted before OneDrive delivered the other one's
  // push must not publish its unchanged, stale copy two minutes later on its own
  handoffState().lastSig = changeSig()
  const timer = setInterval(() => {
    const sig = changeSig()
    if (sig !== handoffState().lastSig) pushNow(sig)
    else beat()
  }, EVERY_MS)
  nitro.hooks.hook('close', () => clearInterval(timer))
})
