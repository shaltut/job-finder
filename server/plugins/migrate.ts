// Applies the schema at startup, the way the original applied schema.sql idempotently from both entry
// points. A missing or corrupt database is the one failure worth crashing the server for: everything
// else in the app assumes these tables exist.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { importLegacy, readSettingsFrom, seedDefaults, writeSettingsTo } from '../../shared/settings.ts'
import { migrateDb, sqlite } from '../utils/db'

const LEGACY_PATH = resolve(process.cwd(), 'config.json')
const SEED_PATH = resolve(process.cwd(), 'data/seed-background.json')

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

/**
 * The curated evidence, gaps and scope that used to be hand-written into the drafter's skill file,
 * carried into the settings row once. Same reasoning as importLegacyConfig above, and the same shape:
 * read at runtime from a gitignored file so that none of it lands in the source.
 *
 * A CLONE HAS NO SUCH FILE and returns on the first line for ever, which is the point — a fresh
 * install onboards through upload-CV, Prefill and Generate, and ends up with its own evidence rather
 * than somebody else's. seedDefaults fills only leaves still holding their defaults, so this cannot
 * overwrite anything edited in Settings and re-running it is a no-op.
 */
function importSeedBackground() {
  if (!existsSync(SEED_PATH)) return
  try {
    const current = readSettingsFrom(sqlite)
    if (!current) return // no row yet: this lands on the boot after the first Save
    const next = seedDefaults(current, JSON.parse(readFileSync(SEED_PATH, 'utf8')))
    if (JSON.stringify(next) === JSON.stringify(current)) return // already seeded, or all edited since
    writeSettingsTo(sqlite, next)
    console.log('[settings] seeded scope and background from data/seed-background.json')
  } catch (e) {
    console.warn(`[settings] could not read the seed file: ${(e as Error).message}`)
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
  // Windows wrote tailored-CV paths with `\`; macOS cannot open them. Idempotent, so it runs every boot.
  // char(92) rather than a literal backslash, which editors and shells keep unescaping.
  const fixed = sqlite.prepare(`UPDATE contacts SET cv_path = replace(cv_path, char(92), '/') WHERE instr(cv_path, char(92)) > 0`).run().changes
  if (fixed) console.log(`[db] normalised ${fixed} tailored-CV path(s) to /`)
  importLegacyConfig() // may create the row
  importSeedBackground() // then fills what the skill file used to hold
})
