// The settings schema and the two SQL statements that store it. Pure: Zod only, no node:fs and no
// better-sqlite3 import, so the same module is importable by the Nitro server, the scraper child
// process, the tests and (as types) the browser bundle.
//
// TWO SCHEMAS, deliberately. `settingsSchema` checks shape and format only and lets every field be
// empty, because a fresh install has to be able to save a half-filled form — you cannot upload a CV
// to fix an incomplete config if the incomplete config is what blocks the save. `missingFields()` is
// the separate completeness gate the run paths gate on. The old single schema conflated the two.
import { z } from 'zod'
import { normalizeCountries } from './countries.ts'

/** '' or a valid instance of the inner check — used for fields that are legitimately unset. */
const blankOr = (inner: z.ZodType, message: string) =>
  z.string().trim().refine(v => v === '' || inner.safeParse(v).success, { message })

export const settingsSchema = z.object({
  profile: z.object({
    name: z.string().trim(),
    title: z.string().trim(),
    location: z.string().trim(),
    // lower-cased so it matches the Gmail sender check and the contacts table's lower-case constraint
    email: blankOr(z.string().email(), 'must be an email address').transform(v => v.toLowerCase()),
    phone: z.string().trim(),
    linkedin: blankOr(z.string().url(), 'must be a URL'),
    github: blankOr(z.string().url(), 'must be a URL'),
    languages: z.string().trim(),
    yearsExperience: z.string().trim()
  }),
  constraints: z.object({
    remoteAnywhere: z.boolean(),
    onsiteCountries: z.array(z.string().trim().min(1)),
    willRelocate: z.array(z.string().trim().min(1)),
    canStartImmediately: z.boolean(),
    workingHours: z.string().trim(),
    stackWeighting: z.enum(['vue-primary', 'equal', 'react-primary'])
  }),
  // existence of the file is checked by assertComplete() on the server, not here: this module has no fs
  cv: z.string().trim(),
  terms: z.array(z.string().trim().min(1)),
  titles: z.array(z.string().trim().min(1)),
  max: z.number().int().min(1).max(200),
  since: z.enum(['past-24h', 'past-week', 'past-month'])
})

export type StoredSettings = z.infer<typeof settingsSchema>
/** Kept as the name the rest of the app already imports. */
export type AppConfig = StoredSettings
export type Profile = StoredSettings['profile']
export type Constraints = StoredSettings['constraints']

/**
 * A fresh install. No contact details, so this is safe under server/ where invariants.test.ts scans
 * for them. The non-string fields carry real defaults rather than emptiness — `max: 40` matches the
 * scraper's own hardcoded fallback.
 *
 * KEY ORDER IS LOAD-BEARING: the Settings page's dirty check is a JSON.stringify comparison, so the
 * server must hand back the same key order it was given or the page reads as permanently dirty.
 */
export const EMPTY_SETTINGS: StoredSettings = {
  profile: {
    name: '', title: '', location: '', email: '', phone: '',
    linkedin: '', github: '', languages: '', yearsExperience: ''
  },
  constraints: {
    remoteAnywhere: true,
    onsiteCountries: [],
    willRelocate: [],
    canStartImmediately: true,
    workingHours: '',
    stackWeighting: 'vue-primary'
  },
  cv: '',
  terms: [],
  titles: [],
  max: 40,
  since: 'past-24h'
}

/** Deep clone, so callers cannot mutate the shared default. */
export const emptySettings = (): StoredSettings => structuredClone(EMPTY_SETTINGS)

const REQUIRED_PROFILE = ['name', 'title', 'location', 'email', 'phone', 'linkedin'] as const

/**
 * What still has to be filled in before a scrape or a draft can run. Pure — the CV file's existence
 * is checked separately by the server, which is the only process that should touch the filesystem
 * to answer that.
 */
export function missingFields(cfg: StoredSettings): string[] {
  const missing: string[] = []
  for (const k of REQUIRED_PROFILE) if (!cfg.profile[k]) missing.push(`profile.${k}`)
  if (!cfg.constraints.workingHours) missing.push('constraints.workingHours')
  if (!cfg.cv) missing.push('cv')
  if (!cfg.terms.length) missing.push('terms: at least one search term')
  if (!cfg.titles.length) missing.push('titles: at least one target title')
  return missing
}

/** Parse, normalising country names to their display form so aliases collapse on the way in. */
export function parseSettings(input: unknown): StoredSettings {
  const parsed = settingsSchema.parse(input)
  parsed.constraints.onsiteCountries = normalizeCountries(parsed.constraints.onsiteCountries)
  parsed.constraints.willRelocate = normalizeCountries(parsed.constraints.willRelocate)
  return parsed
}

// ---------------- storage ----------------

/**
 * The subset of better-sqlite3 this module needs. Duck-typed on purpose: it keeps better-sqlite3 out
 * of the import graph, so the browser bundle can import the types above without pulling a native
 * module, and the read-only scraper handle satisfies it just as well as the server's.
 */
export interface SqlHandle {
  prepare: (sql: string) => {
    // string, not unknown: the only bound parameter here is the JSON blob, and a narrower parameter
    // type is what makes better-sqlite3's overloaded Statement assignable to this contravariantly
    get: (...params: string[]) => unknown
    run: (...params: string[]) => unknown
  }
}

/** The stored row, or undefined when this is a fresh database. Never throws on a missing table. */
export function readSettingsFrom(handle: SqlHandle): StoredSettings | undefined {
  let row: { json?: string } | undefined
  try {
    row = handle.prepare('SELECT json FROM settings WHERE id = 1').get() as { json?: string } | undefined
  } catch {
    return undefined // table not created yet: the migration has not run
  }
  if (!row?.json) return undefined
  try {
    return parseSettings(JSON.parse(row.json))
  } catch {
    return undefined // stored config drifted out of schema; callers fall back to the raw read
  }
}

/** Raw stored object with no validation, for the read paths that must not throw on drift. */
export function readSettingsRawFrom(handle: SqlHandle): unknown {
  try {
    const row = handle.prepare('SELECT json FROM settings WHERE id = 1').get() as { json?: string } | undefined
    return row?.json ? JSON.parse(row.json) : undefined
  } catch {
    return undefined
  }
}

export function writeSettingsTo(handle: SqlHandle, next: unknown): StoredSettings {
  const parsed = parseSettings(next)
  handle.prepare(
    `INSERT INTO settings (id, json, updated_at) VALUES (1, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(parsed))
  return parsed
}

/**
 * One-time import of the legacy config.json. Takes the already-parsed file rather than reading it,
 * so it is testable against an in-memory database. Returns false when a row already exists — this
 * runs on every boot and must never overwrite edits.
 */
export function importLegacy(handle: SqlHandle, legacy: unknown): boolean {
  if (readSettingsRawFrom(handle) !== undefined) return false
  writeSettingsTo(handle, { ...emptySettings(), ...(legacy as object) })
  return true
}

/**
 * What a prefill may propose. Loose on purpose — it is model output, not a validated config, and
 * anything that fails its field's format check is dropped below rather than rejecting the lot.
 */
export interface PrefillProposal {
  profile?: Record<string, unknown>
  terms?: unknown[]
  titles?: unknown[]
}

/**
 * Fill only the fields that are currently empty. This is what makes prefill-from-CV safe to press
 * twice: a value you typed is never replaced by one the model inferred.
 */
export function mergeEmpty(current: StoredSettings, proposal: PrefillProposal): StoredSettings {
  const next = structuredClone(current)
  const p = proposal.profile ?? {}
  for (const [key, v] of Object.entries(p)) {
    const k = key as keyof Profile
    if (!(k in next.profile)) continue // the model invented a field; ignore it
    if (typeof v === 'string' && v.trim() && !next.profile[k]) next.profile[k] = v.trim()
  }
  for (const k of ['terms', 'titles'] as const) {
    const v = proposal[k]
    if (Array.isArray(v) && v.length && !next[k].length) {
      next[k] = [...new Set(v.map(s => String(s).trim()).filter(Boolean))]
    }
  }
  // The model is not trusted to produce a valid email or URL. Rather than reject the whole prefill,
  // drop just the fields that fail and keep the rest — a bad linkedin URL must not cost you the name.
  const result = next
  for (let i = 0; i < 5; i++) {
    const check = settingsSchema.safeParse(result)
    if (check.success) return check.data
    const bad = check.error.issues
      .map(iss => iss.path)
      .filter(path => path[0] === 'profile' && typeof path[1] === 'string')
    if (!bad.length) return current // nothing attributable: keep what the user had
    for (const path of bad) result.profile[path[1] as keyof Profile] = current.profile[path[1] as keyof Profile]
  }
  return current
}
