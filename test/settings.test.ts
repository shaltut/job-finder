import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { isPdf, safeCvName } from '../server/utils/cv.ts'
import { COUNTRIES, normalizeCountries, resolveCountry, tldsFor, withAliases } from '../shared/countries.ts'
import {
  EMPTY_SETTINGS, emptySettings, importLegacy, mergeEmpty, missingFields, missingForDrafting,
  parseSettings, readSettingsFrom, readSettingsRawFrom, seedDefaults, settingsSchema,
  settingsWarnings, upgradeSettings, writeSettingsTo, type StoredSettings
} from '../shared/settings.ts'

/**
 * In-memory, the way ingest.test.ts does it. These target the handle-taking functions rather than
 * readConfig/writeConfig, because those close over the db singleton in server/utils/db.ts, which
 * opens the REAL data/jobfinder.db at module import — a test that touched them would edit live data.
 */
function fresh(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE settings (
    id integer PRIMARY KEY DEFAULT 1,
    json text NOT NULL,
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT settings_single_row CHECK (id = 1)
  )`)
  return db
}

const complete = (): StoredSettings => ({
  ...emptySettings(),
  profile: {
    name: 'Test Person', title: 'Senior Frontend Engineer', location: 'Cairo, Egypt',
    email: 'test@example.com', phone: '+20 100 000 0000',
    linkedin: 'https://www.linkedin.com/in/test', github: '',
    languages: 'Arabic native, English professional', yearsExperience: '10+'
  },
  constraints: {
    remoteAnywhere: true, onsiteCountries: ['Egypt'], willRelocate: [],
    canStartImmediately: true, workingHours: '09:00-21:00 Africa/Cairo'
  },
  cv: 'data/cv/test.pdf',
  terms: ['vue nuxt developer'],
  titles: ['Senior Frontend Engineer']
})

// ---------------- storage ----------------

test('settings round-trip: write then read returns the same object', () => {
  const db = fresh()
  const cfg = complete()
  writeSettingsTo(db, cfg)
  assert.deepEqual(readSettingsFrom(db), cfg)
})

test('a fresh database reads as undefined rather than throwing', () => {
  // no settings table at all: the migration has not run yet
  assert.equal(readSettingsFrom(new Database(':memory:')), undefined)
  // table present, no row
  const db = fresh()
  assert.equal(readSettingsFrom(db), undefined)
  assert.equal(readSettingsRawFrom(db), undefined)
})

test('writing normalises: email lower-cased, strings trimmed, country aliases collapsed', () => {
  const db = fresh()
  const saved = writeSettingsTo(db, {
    ...complete(),
    profile: { ...complete().profile, email: '  MiXeD@Case.COM ', name: '  Spaced  ' },
    constraints: { ...complete().constraints, onsiteCountries: ['United Arab Emirates', 'KSA', 'UAE'] }
  })
  assert.equal(saved.profile.email, 'mixed@case.com')
  assert.equal(saved.profile.name, 'Spaced')
  // aliases collapse to display form AND de-duplicate
  assert.deepEqual(saved.constraints.onsiteCountries, ['UAE', 'Saudi Arabia'])
})

test('a malformed email is refused with a field-level message', () => {
  const db = fresh()
  assert.throws(
    () => writeSettingsTo(db, { ...complete(), profile: { ...complete().profile, email: 'not-an-email' } }),
    (e: { issues: { path: (string | number)[], message: string }[] }) => {
      assert.equal(e.issues[0]!.path.join('.'), 'profile.email')
      assert.match(e.issues[0]!.message, /email/)
      return true
    }
  )
})

test('an empty config still saves — a fresh install must be able to fill the form in stages', () => {
  const db = fresh()
  const saved = writeSettingsTo(db, emptySettings())
  assert.equal(saved.cv, '')
  assert.deepEqual(saved.terms, [])
})

// ---------------- the completeness gate ----------------

test('missingFields names every unset field on a fresh config, and none on a complete one', () => {
  const missing = missingFields(emptySettings())
  assert.ok(missing.includes('profile.email'))
  assert.ok(missing.includes('cv'))
  assert.ok(missing.some(m => m.startsWith('terms')))
  assert.deepEqual(missingFields(complete()), [])
})

// ---------------- the one-time legacy import ----------------

test('importLegacy runs once and never overwrites an existing row', () => {
  const db = fresh()
  const legacy = { ...complete(), profile: { ...complete().profile, name: 'From config.json' } }
  assert.equal(importLegacy(db, legacy), true)
  assert.equal(readSettingsFrom(db)!.profile.name, 'From config.json')

  // a second boot must be a no-op, even if the file still says something else
  assert.equal(importLegacy(db, { ...legacy, profile: { ...legacy.profile, name: 'Stale' } }), false)
  assert.equal(readSettingsFrom(db)!.profile.name, 'From config.json')
})

test('importLegacy resolves legacy country spellings and tolerates missing keys', () => {
  const db = fresh()
  // the shape config.json actually has, with the short 'UAE' the old hardcoded picker wrote
  importLegacy(db, {
    ...complete(),
    constraints: { ...complete().constraints, onsiteCountries: ['Egypt', 'UAE'], willRelocate: ['United Arab Emirates'] }
  })
  const got = readSettingsFrom(db)!
  assert.deepEqual(got.constraints.onsiteCountries, ['Egypt', 'UAE'])
  assert.deepEqual(got.constraints.willRelocate, ['UAE'], 'the long form resolves to the same entry')

  // a legacy file missing a key the schema needs falls back to the empty default rather than throwing
  const db2 = fresh()
  const { max: _max, ...noMax } = complete()
  assert.equal(importLegacy(db2, noMax), true)
  assert.equal(readSettingsFrom(db2)!.max, 40)
})

// ---------------- prefill merge ----------------

test('mergeEmpty fills blanks and never touches a field you set', () => {
  const current = { ...emptySettings(), profile: { ...emptySettings().profile, name: 'Yours' } }
  const merged = mergeEmpty(current, {
    profile: { name: 'The Model', title: 'Senior Frontend Engineer', email: 'CV@Example.com' },
    titles: ['Frontend Engineer', 'Frontend Engineer', ' Vue Developer ']
  })
  assert.equal(merged.profile.name, 'Yours', 'a value you typed survives')
  assert.equal(merged.profile.title, 'Senior Frontend Engineer', 'a blank gets filled')
  assert.equal(merged.profile.email, 'cv@example.com')
  assert.deepEqual(merged.titles, ['Frontend Engineer', 'Vue Developer'], 'trimmed and de-duplicated')
})

test('mergeEmpty drops only the fields the model got wrong', () => {
  const merged = mergeEmpty(emptySettings(), {
    profile: { name: 'Good Name', email: 'not-an-email', linkedin: 'also-not-a-url' }
  })
  assert.equal(merged.profile.name, 'Good Name', 'a bad URL must not cost you the name')
  assert.equal(merged.profile.email, '')
  assert.equal(merged.profile.linkedin, '')
})

test('mergeEmpty leaves the constraints alone — a CV cannot know them', () => {
  const merged = mergeEmpty(emptySettings(), {
    profile: { name: 'X' },
    constraints: { onsiteCountries: ['France'], workingHours: '24/7' }
  } as Partial<StoredSettings>)
  assert.deepEqual(merged.constraints, emptySettings().constraints)
})

// ---------------- countries ----------------

test('the country table is complete, unique, and resolves aliases case-insensitively', () => {
  assert.ok(COUNTRIES.length > 190, `expected the full ISO list, got ${COUNTRIES.length}`)
  assert.equal(new Set(COUNTRIES.map(c => c.code)).size, COUNTRIES.length, 'duplicate alpha-2 code')
  assert.equal(new Set(COUNTRIES.map(c => c.name)).size, COUNTRIES.length, 'duplicate display name')

  assert.equal(resolveCountry('United Arab Emirates')!.name, 'UAE')
  assert.equal(resolveCountry('  ksa ')!.name, 'Saudi Arabia')
  assert.equal(resolveCountry('EGYPT')!.name, 'Egypt')
  assert.equal(resolveCountry('Atlantis'), undefined)
})

test('tldsFor derives the email-domain hint instead of hardcoding .eg .sa .ae .qa', () => {
  assert.deepEqual(tldsFor(['Egypt', 'Saudi Arabia', 'UAE', 'Qatar']), ['.eg', '.sa', '.ae', '.qa'])
  // the scope is dynamic now: a different selection must produce a different hint
  assert.deepEqual(tldsFor(['Germany', 'Kuwait']), ['.de', '.kw'])
  // GB is the alpha-2, .uk is the ccTLD
  assert.deepEqual(tldsFor(['UK']), ['.uk'])
  assert.deepEqual(tldsFor(['Atlantis']), [])
})

test('normalizeCountries keeps a name it does not recognise', () => {
  // silently deleting a stored country on every save would be data loss the user never asked for
  assert.deepEqual(normalizeCountries(['United Arab Emirates', 'Atlantis']), ['UAE', 'Atlantis'])
})

test('withAliases inlines the long forms so the scoring model matches post text', () => {
  assert.equal(withAliases(['UAE']), 'UAE (United Arab Emirates, Emirates, U.A.E.)')
  assert.equal(withAliases(['Qatar']), 'Qatar (State of Qatar)')
})

test('a stored country that is not in the table survives a round-trip', () => {
  const db = fresh()
  const saved = writeSettingsTo(db, {
    ...complete(),
    constraints: { ...complete().constraints, onsiteCountries: ['Egypt', 'Atlantis'] }
  })
  assert.deepEqual(saved.constraints.onsiteCountries, ['Egypt', 'Atlantis'])
})

test('parseSettings strips a key the schema no longer has, and the upgrade does too', () => {
  // This is how `constraints.stackWeighting` left. Zod drops unknown keys on parse, so the first Save
  // after a field is removed erases it from the stored row — which means anything that had to survive
  // it (here, the primary/secondary skills it became) must be carried across BEFORE that save, never
  // by a migration written afterwards.
  const withDeadKey = { ...complete(), constraints: { ...complete().constraints, stackWeighting: 'vue-primary' } }
  const parsed = parseSettings(withDeadKey)
  assert.ok(!('stackWeighting' in parsed.constraints))
  assert.equal(parsed.constraints.workingHours, complete().constraints.workingHours)
  assert.ok(!('stackWeighting' in (upgradeSettings(withDeadKey) as StoredSettings).constraints))
})

// ---------------- CV upload safety ----------------

test('safeCvName never lets a filename escape the CV directory', () => {
  // the client's filename is an input like any other; these are the shapes that would write elsewhere
  assert.equal(safeCvName('../../../etc/passwd'), 'passwd.pdf')
  assert.equal(safeCvName('../../evil.pdf'), 'evil.pdf')
  assert.equal(safeCvName('/absolute/path/CV.pdf'), 'CV.pdf')
  assert.equal(safeCvName('a/b/c.pdf'), 'c.pdf')
  for (const name of ['../../../etc/passwd', '..\\..\\win.pdf', './../x.pdf', '....//y.pdf']) {
    const out = safeCvName(name)
    assert.ok(!/[/\\]/.test(out), `${name} -> ${out} still contains a separator`)
    assert.ok(!out.includes('..'), `${name} -> ${out} still contains ..`)
  }
})

test('safeCvName forces a .pdf extension and survives a hostile name', () => {
  assert.equal(safeCvName('Test Person CV.pdf'), 'Test-Person-CV.pdf')
  assert.equal(safeCvName('resume.docx'), 'resume.pdf')
  assert.equal(safeCvName(''), 'cv.pdf')
  assert.equal(safeCvName('...'), 'cv.pdf')
  assert.equal(safeCvName('a'.repeat(200)), `${'a'.repeat(80)}.pdf`)
})

test('isPdf checks the bytes, not the client content-type', () => {
  assert.equal(isPdf(Buffer.from('%PDF-1.7 rest of file')), true)
  assert.equal(isPdf(Buffer.from('<html>not a pdf</html>')), false)
  assert.equal(isPdf(Buffer.from('PK a zip pretending')), false)
  assert.equal(isPdf(Buffer.from('')), false)
})

// ---------------- shape, and the upgrade that keeps old rows readable ----------------

/** A row as it was stored before scope/background existed. Literal on purpose: a fixture built from
 *  emptySettings() would silently acquire every new field and prove nothing. */
const oldShapeRow = () => ({
  profile: {
    name: 'Test Person', title: 'Senior Frontend Engineer', location: 'Cairo, Egypt',
    email: 'test@example.com', phone: '+20 100 000 0000',
    linkedin: 'https://www.linkedin.com/in/test', github: '',
    languages: 'Arabic native, English professional', yearsExperience: '10+'
  },
  constraints: {
    remoteAnywhere: true, onsiteCountries: ['Egypt'], willRelocate: [],
    canStartImmediately: true, workingHours: '09:00-21:00 Africa/Cairo'
  },
  cv: 'data/cv/test.pdf',
  terms: ['vue nuxt developer', 'feed'],
  titles: ['Senior Frontend Engineer'],
  max: 40,
  since: 'past-24h'
})

test('the schema shape order matches EMPTY_SETTINGS key order, at every level', () => {
  // Zod emits keys in SCHEMA order and strips unknown ones, while the Settings page's dirty check is
  // a JSON.stringify comparison. So if these two ever disagree the page reads as permanently dirty,
  // and nothing else in the suite would say why.
  const walk = (shape: Record<string, unknown>, obj: Record<string, unknown>, at: string) => {
    assert.deepEqual(Object.keys(shape), Object.keys(obj), `key order differs at ${at}`)
    for (const [k, v] of Object.entries(shape)) {
      const inner = (v as { shape?: Record<string, unknown> })?.shape
      if (inner) walk(inner, obj[k] as Record<string, unknown>, `${at}.${k}`)
    }
  }
  walk(settingsSchema.shape as unknown as Record<string, unknown>, EMPTY_SETTINGS as unknown as Record<string, unknown>, 'root')
  assert.equal(JSON.stringify(parseSettings(emptySettings())), JSON.stringify(EMPTY_SETTINGS))
})

test('upgradeSettings passes undefined through, so importLegacy can still tell an empty database', () => {
  // importLegacy's "a row already exists" guard IS this value. Returning EMPTY_SETTINGS here would
  // make the one-time legacy import impossible to ever fire again.
  assert.equal(upgradeSettings(undefined), undefined)
  const db = fresh()
  assert.equal(readSettingsRawFrom(db), undefined)
  assert.equal(importLegacy(db, oldShapeRow()), true)
  assert.equal(importLegacy(db, oldShapeRow()), false)
})

test('upgradeSettings fills a row written before scope and background existed, and is idempotent', () => {
  const up = upgradeSettings(oldShapeRow()) as StoredSettings
  assert.deepEqual(Object.keys(up), Object.keys(EMPTY_SETTINGS))
  assert.deepEqual(up.scope, EMPTY_SETTINGS.scope)
  assert.deepEqual(up.background, EMPTY_SETTINGS.background)
  // every stored value survives — this is the failure that would look like "my settings vanished"
  assert.deepEqual(up.terms, ['vue nuxt developer', 'feed'])
  assert.deepEqual(up.titles, ['Senior Frontend Engineer'])
  assert.equal(up.cv, 'data/cv/test.pdf')
  assert.equal(up.constraints.workingHours, '09:00-21:00 Africa/Cairo')
  assert.deepEqual(upgradeSettings(up), up)
})

test('upgradeSettings fixes shape but never format: a bad stored value is still shown to you', () => {
  const up = upgradeSettings({ ...oldShapeRow(), profile: { ...oldShapeRow().profile, email: 'not-an-email' } }) as StoredSettings
  assert.equal(up.profile.email, 'not-an-email')
})

test('both read paths survive a row stored before the new fields existed', () => {
  const db = fresh()
  // written raw, bypassing writeSettingsTo, exactly as a pre-upgrade install has it on disk
  db.prepare('INSERT INTO settings (id, json, updated_at) VALUES (1, ?, unixepoch())')
    .run(JSON.stringify(oldShapeRow()))

  const typed = readSettingsFrom(db)
  assert.ok(typed, 'the typed read must not fall back to empty settings on an old row')
  assert.deepEqual(typed.terms, ['vue nuxt developer', 'feed'])
  assert.deepEqual(typed.background, EMPTY_SETTINGS.background)

  const raw = readSettingsRawFrom(db) as StoredSettings
  assert.ok(raw.background, 'the raw read feeds the Settings form, which binds to background.*')
  assert.deepEqual(raw.scope, EMPTY_SETTINGS.scope)
})

// ---------------- the two completeness tiers ----------------

test('missingForDrafting names evidence, and never repeats a base field', () => {
  assert.deepEqual(missingFields(complete()), [])
  assert.equal(missingForDrafting(complete()).length, 1)
  assert.match(missingForDrafting(complete())[0]!, /background\.evidence/)
  const withEvidence = { ...complete(), background: { ...complete().background, evidence: 'Ten years of X.' } }
  assert.deepEqual(missingForDrafting(withEvidence), [])
})

test('settingsWarnings flags an empty gaps list without ever blocking a run', () => {
  const w = settingsWarnings(complete())
  assert.ok(w.some(x => x.includes('background.gaps')))
  assert.ok(w.some(x => x.includes('scope.roleFamily')))
  const filled = {
    ...complete(),
    scope: { ...complete().scope, roleFamily: 'nursing', primarySkills: ['paediatrics'] },
    background: { ...complete().background, gaps: ['No ICU experience.'] }
  }
  assert.deepEqual(settingsWarnings(filled), [])
})

// ---------------- merge and seed ----------------

test('mergeEmpty fills scope and background only while they are empty, and never a number', () => {
  const base = complete()
  const filled = mergeEmpty(base, {
    scope: { roleFamily: 'structural engineering', primarySkills: ['ETABS', 'SAP2000'], seniorityFloor: 9 },
    background: { evidence: 'Nine years designing bridges.', gaps: ['No seismic retrofit work.'] }
  })
  assert.equal(filled.scope.roleFamily, 'structural engineering')
  assert.deepEqual(filled.scope.primarySkills, ['ETABS', 'SAP2000'])
  assert.equal(filled.background.evidence, 'Nine years designing bridges.')
  // a model may not set a threshold that silently hides postings
  assert.equal(filled.scope.seniorityFloor, 0)

  const again = mergeEmpty(filled, { scope: { roleFamily: 'something else' }, background: { evidence: 'rewritten' } })
  assert.equal(again.scope.roleFamily, 'structural engineering', 'a value already there is never replaced')
  assert.equal(again.background.evidence, 'Nine years designing bridges.')
})

test('seedDefaults fills untouched leaves, skips edited ones, and is a no-op on a second run', () => {
  const current = { ...complete(), scope: { ...complete().scope, roleFamily: 'already chosen' } }
  const seed = {
    scope: { roleFamily: 'ignored', primarySkills: ['Vue', 'Nuxt'], seniorityFloor: 5 },
    background: { evidence: 'The curated evidence.', gaps: ['No cloud or DevOps.'] }
  }
  const once = seedDefaults(current, seed)
  assert.equal(once.scope.roleFamily, 'already chosen', 'an edited leaf is never overwritten')
  assert.deepEqual(once.scope.primarySkills, ['Vue', 'Nuxt'])
  // unlike mergeEmpty, a seed is a file you wrote, so it MAY set the threshold
  assert.equal(once.scope.seniorityFloor, 5)
  assert.equal(once.background.evidence, 'The curated evidence.')
  assert.deepEqual(seedDefaults(once, seed), once)
})
