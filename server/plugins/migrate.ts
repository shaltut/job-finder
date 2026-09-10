// Applies the schema at startup, the way the original applied schema.sql idempotently from both entry
// points. A missing or corrupt database is the one failure worth crashing the server for: everything
// else in the app assumes these tables exist.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { importLegacy } from '../../shared/settings.ts'
import { migrateDb, sqlite } from '../utils/db'

const LEGACY_PATH = resolve(process.cwd(), 'config.json')

/**
 * Settings used to live in a git-tracked config.json, which meant a real phone number and email
 * address sat in a repository. They now live in the database. This carries the old file across once
 * and then never touches it again — the row existing is what makes it a no-op, so it cannot
 * overwrite anything edited in Settings afterwards.
 *
 * A migration cannot seed these values instead: invariants.test.ts fails if a contact detail appears
 * anywhere under server/, and putting one there would defeat the rule that test protects. Reading the
 * file at runtime keeps the source clean, which is also why a fresh install onboards through
 * upload-CV-then-prefill rather than through a seeded row.
 */
function importLegacyConfig() {
  if (!existsSync(LEGACY_PATH)) return
  try {
    if (importLegacy(sqlite, JSON.parse(readFileSync(LEGACY_PATH, 'utf8')))) {
      console.log('[settings] imported config.json into the database — the file is no longer read')
    }
  } catch (e) {
    console.warn(`[settings] could not import config.json: ${(e as Error).message}`)
  }
}

export default defineNitroPlugin(() => {
  try {
    const r = migrateDb()
    if (r.migrated) console.log('[db] schema up to date')
    else console.warn(`[db] migrations not applied: ${r.reason} — run \`npm run db:generate\``)
  } catch (e) {
    console.error(`[db] migration failed: ${(e as Error).message}`)
    throw e
  }
  importLegacyConfig()
})
