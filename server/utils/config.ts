// The profile, constraints and search settings, stored as one row in SQLite. The Settings page is a
// form over this; the scoring prompt and the drafter's system prompt are built from it at run time.
// Nothing here is hardcoded in the source, so retargeting the tool is data entry, not editing.
//
// This file is the server's view of shared/settings.ts, which holds the schema and the SQL and is
// shared with the scraper and the tests. The one thing that cannot live there is the CV file check:
// shared/ has no filesystem access by design, and the browser bundle imports its types.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  emptySettings, missingFields, readSettingsFrom, readSettingsRawFrom, writeSettingsTo,
  type StoredSettings
} from '../../shared/settings.ts'
import { sqlite } from './db'

export type AppConfig = StoredSettings
export { settingsSchema, emptySettings, missingFields } from '../../shared/settings.ts'

/**
 * The complete, runnable config. Throws when anything a scrape or a draft needs is still unset, so
 * the failure lands at the start of a job rather than mid-run — the behaviour readConfig() has
 * always had, now that the schema itself permits a half-filled form to be saved.
 */
export function readConfig(): AppConfig {
  const cfg = readSettingsFrom(sqlite) ?? emptySettings()
  assertComplete(cfg)
  return cfg
}

/**
 * Raw read for callers that must not throw: the Settings page has to load in order to FIX an
 * incomplete config, and the Gmail status card is rendered on that same page. Returns the empty
 * defaults on a fresh database. Contains no contact details, so it is safe under server/ where
 * invariants.test.ts scans for them.
 */
export function readConfigRaw(): unknown {
  return readSettingsRawFrom(sqlite) ?? emptySettings()
}

/** Best-effort typed read that never throws — for the paths that want a value, not an exception. */
export function readConfigLoose(): AppConfig {
  return readSettingsFrom(sqlite) ?? emptySettings()
}

export function writeConfig(next: unknown): AppConfig {
  return writeSettingsTo(sqlite, next)
}

/** Merge a few fields into the stored row. Used by the CV upload, which writes outside the form. */
export function patchConfig(partial: Partial<AppConfig>): AppConfig {
  return writeSettingsTo(sqlite, { ...readConfigLoose(), ...partial })
}

/**
 * The run gate. Field completeness comes from shared/, the CV file check is here because only the
 * server should touch the filesystem to answer it. The message is one readable line per problem,
 * matching what the Settings PUT already returns for a validation failure.
 */
export function assertComplete(cfg: AppConfig): void {
  const problems = missingFields(cfg).map(f => `${f}: not set`)
  if (cfg.cv && !existsSync(resolve(process.cwd(), cfg.cv))) problems.push('cv: file does not exist')
  if (problems.length) {
    throw new Error(`Settings are incomplete — ${problems.join('; ')}`)
  }
}

/** Absolute path to the CV, from the repo-relative path the upload stores. */
export function cvPath(cfg: AppConfig): string {
  return resolve(process.cwd(), cfg.cv)
}
