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

/**
 * The contact routes a post can offer, in the order they are stored and shown. Here rather than in
 * scraper/lib.ts because the Settings form binds to it and this module is the one both can import:
 * lib.ts reaches for node:crypto, which has no business in a browser bundle.
 */
export const CONTACT_CHANNELS = ['email', 'link', 'phone'] as const
export type ContactChannel = (typeof CONTACT_CHANNELS)[number]

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
    workingHours: z.string().trim()
  }),
  // What counts as a match. Read by the scorer, the pre-screen AND the drafter — which is why it is
  // separate from `background` below, whose only consumer is the drafter. Nothing here names a
  // profession: `roleFamily` is whatever the person does, and an empty list means "no such rule",
  // never a hardcoded default.
  scope: z.object({
    roleFamily: z.string().trim().max(120),
    primarySkills: z.array(z.string().trim().min(1).max(60)).max(20),
    secondarySkills: z.array(z.string().trim().min(1).max(60)).max(20),
    excludedRoles: z.array(z.string().trim().min(1).max(120)).max(20),
    // 0 turns the check off, and 0 is the default: the tool does not know your level until you say.
    seniorityFloor: z.number().int().min(0).max(50)
  }),
  // existence of the file is checked by assertComplete() on the server, not here: this module has no fs
  cv: z.string().trim(),
  terms: z.array(z.string().trim().min(1)),
  titles: z.array(z.string().trim().min(1)),
  max: z.number().int().min(1).max(200),
  since: z.enum(['past-24h', 'past-week', 'past-month']),
  // Which contact routes admit a post to the database. Email is the only one a draft can reach, so it
  // is the default and the other two are opt-in — a post kept for its link or its number is one the
  // owner has to apply to by hand. Not `.min(1)` here on purpose: this schema checks shape only and a
  // half-filled form must still save (see the note at the top). missingFields() is the run gate.
  contactChannels: z.array(z.enum(CONTACT_CHANNELS)),
  // What an application email may say. Replaces the hand-written Evidence and Gaps sections that
  // used to live in the drafter skill file, so retargeting this tool stays data entry.
  //
  // `gaps` is a LIST, not prose, because each entry is an atomic claim the user must be able to
  // delete on its own — that per-item review is the defence against a generated gap nobody has.
  // `evidence` is prose because its structure is nested (roles, then work, then tools per piece of
  // work) and any flattening loses the grouping that stops the model attaching one project's tools
  // to another. The caps are not cosmetic: this is spliced into a system prompt spawned once per
  // recruiter, so an uncapped blob is a token bill and a prompt-length failure.
  background: z.object({
    strengths: z.array(z.string().trim().min(1).max(120)).max(20),
    evidence: z.string().trim().max(8000),
    gaps: z.array(z.string().trim().min(1).max(600)).max(30),
    neverClaim: z.array(z.string().trim().min(1).max(200)).max(20)
  })
})

export type StoredSettings = z.infer<typeof settingsSchema>
/** Kept as the name the rest of the app already imports. */
export type AppConfig = StoredSettings
export type Profile = StoredSettings['profile']
export type Constraints = StoredSettings['constraints']
export type Scope = StoredSettings['scope']
export type Background = StoredSettings['background']

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
    workingHours: ''
  },
  scope: { roleFamily: '', primarySkills: [], secondarySkills: [], excludedRoles: [], seniorityFloor: 0 },
  cv: '',
  terms: [],
  titles: [],
  max: 40,
  since: 'past-24h',
  contactChannels: ['email'],
  background: { strengths: [], evidence: '', gaps: [], neverClaim: [] }
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
  // every channel switched off admits nothing, which is a scrape that silently stores no rows
  if (!cfg.contactChannels.length) missing.push('contactChannels: at least one contact type')
  return missing
}

/**
 * The EXTRAS a draft needs on top of missingFields(). Deliberately does not repeat the base list, so
 * the status endpoint can show two tiers without de-duplicating them.
 *
 * Evidence blocks and gaps only warns. A draft with no evidence cannot be written honestly at all;
 * a draft with no gaps degrades gracefully to "declare none", which is correct for someone who has
 * none. And a required field that people satisfy with junk is worse than an unrequired one.
 */
export function missingForDrafting(cfg: StoredSettings): string[] {
  const missing: string[] = []
  if (!cfg.background.evidence) missing.push('background.evidence: nothing for the email to draw on')
  return missing
}

/** Non-blocking. Things that make every run worse but must never stop one. */
export function settingsWarnings(cfg: StoredSettings): string[] {
  const w: string[] = []
  if (!cfg.background.gaps.length) w.push('background.gaps is empty — every email will read as if you have no gaps at all')
  if (!cfg.scope.roleFamily) w.push('scope.roleFamily is not set — the scorer cannot rule out roles from other fields')
  if (!cfg.scope.primarySkills.length) w.push('scope.primarySkills is empty — nothing scores higher than anything else')
  return w
}

// ---------------- shape upgrade ----------------

type Plain = Record<string, unknown>
const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)

/** Rebuild in the DEFAULT's key order, keeping a stored value only when its type matches. */
function shapeOver(def: Plain, src: Plain): Plain {
  const out: Plain = {}
  for (const [k, d] of Object.entries(def)) {
    const v = src[k]
    if (isPlain(d)) out[k] = shapeOver(d, isPlain(v) ? v : {})
    else if (Array.isArray(d)) out[k] = Array.isArray(v) ? v : d
    else if (typeof v === typeof d) out[k] = v
    else out[k] = d
  }
  return out
}

/**
 * Any stored object into the CURRENT shape. SHAPE ONLY: a value that fails its *format* check — a
 * malformed email — is preserved untouched, because readConfigRaw()'s whole job is to show you the
 * thing you have to fix.
 *
 * Applied on every read rather than once at boot, so it also covers a database restored from
 * backups/ and the scraper child's own read-only handle, whichever process opens it first. That
 * matters more than it looks: scraper/run.ts swallows a settings read failure and falls back to
 * emptySettings(), so a row that merely predates a new field would make a scrape report "no search
 * terms configured" against a settings row that is completely full.
 *
 * Total and idempotent. `undefined` passes through UNCHANGED and that is load-bearing — importLegacy
 * uses "the raw read returned undefined" as its "no row yet" guard, and handing back EMPTY_SETTINGS
 * here would make the legacy import impossible to ever fire.
 */
export function upgradeSettings(stored: unknown): unknown {
  if (!isPlain(stored)) return stored
  return shapeOver(emptySettings() as unknown as Plain, stored)
}

/**
 * Trusted, user-written seed data — the curated evidence and gaps that used to live in the drafter
 * skill file, carried into the settings row once.
 *
 * Fills a leaf ONLY while it still holds its EMPTY_SETTINGS default, so it can never overwrite an
 * edit and re-running it is a no-op. Not mergeEmpty(): that one guards against MODEL output and so
 * refuses numbers and booleans outright. A seed is a file you wrote yourself, so it may set
 * scope.seniorityFloor. The guard is per LEAF rather than per section — otherwise generating from
 * the CV once before the seed lands would silently skip everything beside it.
 */
export function seedDefaults(current: StoredSettings, seed: unknown): StoredSettings {
  if (!isPlain(seed)) return current
  const def = EMPTY_SETTINGS as unknown as Plain
  const next = structuredClone(current) as unknown as Plain
  const walk = (d: Plain, cur: Plain, src: Plain) => {
    for (const [k, v] of Object.entries(src)) {
      if (!(k in d)) continue
      const dv = d[k]
      if (isPlain(dv)) {
        if (isPlain(v) && isPlain(cur[k])) walk(dv, cur[k] as Plain, v)
        continue
      }
      const atDefault = Array.isArray(dv) ? (cur[k] as unknown[]).length === 0 : cur[k] === dv
      if (!atDefault) continue
      if (Array.isArray(dv) ? Array.isArray(v) : typeof v === typeof dv) cur[k] = v
    }
  }
  walk(def, next, seed)
  return next as unknown as StoredSettings
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
    return parseSettings(upgradeSettings(JSON.parse(row.json)))
  } catch {
    return undefined // stored config drifted out of schema; callers fall back to the raw read
  }
}

/** Raw stored object with no validation, for the read paths that must not throw on drift. */
export function readSettingsRawFrom(handle: SqlHandle): unknown {
  try {
    const row = handle.prepare('SELECT json FROM settings WHERE id = 1').get() as { json?: string } | undefined
    // upgraded, so a row written before a field existed still hands the Settings form every key it
    // binds to. Shape only — an invalid stored value is still shown to you, because fixing it is
    // exactly what this read is for.
    return row?.json ? upgradeSettings(JSON.parse(row.json)) : undefined
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
  scope?: Record<string, unknown>
  background?: Record<string, unknown>
  terms?: unknown[]
  titles?: unknown[]
}

/** The sections a model is allowed to propose into. Numbers and booleans are never filled here. */
const MERGE_SECTIONS = ['profile', 'scope', 'background'] as const

/**
 * Fill only the fields that are currently empty. This is what makes prefill-from-CV safe to press
 * twice: a value you typed is never replaced by one the model inferred.
 */
export function mergeEmpty(current: StoredSettings, proposal: PrefillProposal): StoredSettings {
  const next = structuredClone(current)
  for (const section of MERGE_SECTIONS) {
    const proposed = proposal[section] ?? {}
    const target = next[section] as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(proposed)) {
      if (!(k in target)) continue // the model invented a field; ignore it
      const cur = target[k]
      if (typeof cur === 'string' && typeof v === 'string' && v.trim() && !cur) target[k] = v.trim()
      else if (Array.isArray(cur) && Array.isArray(v) && !cur.length) {
        const items = [...new Set(v.map(x => String(x).trim()).filter(Boolean))]
        if (items.length) target[k] = items
      }
      // numbers and booleans are never model-filled: the same rule that keeps a model out of
      // willRelocate and canStartImmediately keeps it out of scope.seniorityFloor.
    }
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
      .filter(path => (MERGE_SECTIONS as readonly unknown[]).includes(path[0]) && typeof path[1] === 'string')
    if (!bad.length) return current // nothing attributable: keep what the user had
    for (const [section, key] of bad) {
      const sec = section as typeof MERGE_SECTIONS[number]
      ;(result[sec] as unknown as Record<string, unknown>)[key as string]
        = (current[sec] as unknown as Record<string, unknown>)[key as string]
    }
  }
  return current
}
