// Applies the schema at startup, the way the original applied schema.sql idempotently from both entry
// points. A missing or corrupt database is the one failure worth crashing the server for: everything
// else in the app assumes these three tables exist.
import { migrateDb } from '../utils/db'

export default defineNitroPlugin(() => {
  try {
    const r = migrateDb()
    if (r.migrated) console.log('[db] schema up to date')
    else console.warn(`[db] migrations not applied: ${r.reason} — run \`npm run db:generate\``)
  } catch (e) {
    console.error(`[db] migration failed: ${(e as Error).message}`)
    throw e
  }
})
