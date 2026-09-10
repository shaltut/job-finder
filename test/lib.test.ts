import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ageOf, dedupeKey, extractEmails, FLAG_RULES, normalize, postedAt, prescreen, searchUrl, systemPrompt
} from '../scraper/lib.ts'
import type { Config } from '../scraper/lib.ts'
import { emptySettings } from '../shared/settings.ts'

// A fixture, not the stored settings: these assert what systemPrompt DOES with a config, which must
// hold for any config, and a test that reads one person's settings cannot run on a fresh clone.
const config: Config = {
  ...emptySettings(),
  constraints: {
    ...emptySettings().constraints,
    onsiteCountries: ['Egypt', 'Saudi Arabia', 'UAE', 'Qatar'],
    willRelocate: ['Saudi Arabia', 'UAE', 'Qatar']
  },
  cv: 'data/cv/test.pdf',
  terms: ['feed', 'vue nuxt developer'],
  titles: ['Senior Frontend Engineer', 'Nuxt Developer']
}

test('extractEmails: dedupes, lower-cases, merges mailto links', () => {
  assert.deepEqual(extractEmails('Send CV to HR@Acme.sa or jobs@x.co.uk today', ['hr@acme.sa']), ['hr@acme.sa', 'jobs@x.co.uk'])
  assert.deepEqual(extractEmails('x@y.COM and a.b@c.co.uk'), ['x@y.com', 'a.b@c.co.uk'])
  assert.deepEqual(extractEmails('no contact here'), [])
})

test('extractEmails: strips a capitalised word glued on by innerText', () => {
  // LinkedIn renders 'hr@acme.com.Apply now' with no space after the domain
  assert.deepEqual(extractEmails('Email: hr@acme.com.Apply now, or hr@acme.com.Thanks', ['hr@acme.com']), ['hr@acme.com'])
})

test('dedupeKey: keyed on author + the first 160 chars', () => {
  const k1 = dedupeKey('https://www.linkedin.com/in/a', 'x'.repeat(200))
  assert.equal(k1, dedupeKey('https://www.linkedin.com/in/a', 'x'.repeat(160) + 'different tail'))
  assert.notEqual(k1, dedupeKey('https://www.linkedin.com/in/b', 'x'.repeat(200)))
  assert.match(k1, /^[0-9a-f]{40}$/)
})

test('dedupeKey: survives the drifting header (the bug that stored one row per hour)', () => {
  const hdr = (age: string) =>
    `Feed post\nHeba Zaki\n • 2nd\nTalent Acquisition\n${age} • \nFollow\nWe are hiring a Vue lead. Send CV to hr@x.com`
  assert.equal(dedupeKey('u', hdr('21h')), dedupeKey('u', hdr('1d')))
  assert.equal(dedupeKey('u', hdr('21h')), dedupeKey('u', hdr('21h').replace('Follow', 'Following').replace('2nd', '1st')))
  // but a genuinely different post must still key differently
  assert.notEqual(dedupeKey('u', hdr('21h')), dedupeKey('u', hdr('21h').replace('Vue lead', 'Java lead')))
})

test('normalize: folds an Arabic-rendered age back to its English form', () => {
  const arab = 'Feed post\n‏منشور في سجل الأنشطة\nHeba Zaki\n‏٣‏ من الساعات • \nWe are hiring a Vue lead. Send CV to hr@x.com'
  assert.equal(ageOf(normalize(arab)), '3h') // '٣ من الساعات' -> '3h'
  // 3h -> 4h must key the same, or the post lands again tomorrow
  assert.equal(dedupeKey('u', normalize(arab)), dedupeKey('u', normalize(arab.replace('٣', '٤'))))
})

test('normalize: converts digits only, never invents a time unit', () => {
  assert.equal(ageOf(normalize('Feed post\nHeba Zaki\n • 2nd\n21h • ')), '21h') // '2nd' is not an age
  assert.equal(normalize('٥+ سنين React'), '5+ سنين React')
})

test('postedAt: pins a relative age to an instant', () => {
  const t0 = new Date('2026-09-08T10:00:00Z')
  assert.equal(postedAt('2h', t0)!.toISOString(), '2026-09-08T08:00:00.000Z')
  assert.equal(postedAt('1d', t0)!.toISOString(), '2026-09-07T10:00:00.000Z')
  assert.equal(postedAt('36m', t0)!.toISOString(), '2026-09-08T09:24:00.000Z')
  assert.equal(postedAt('2mo', t0)!.toISOString(), '2026-07-10T10:00:00.000Z')
  assert.equal(postedAt('', t0), null)
  assert.equal(postedAt('Edited', t0), null)
})

test('searchUrl: encodes the term and the date filter', () => {
  assert.match(searchUrl('vue nuxt developer', 'past-24h'), /keywords=vue%20nuxt%20developer&datePosted=%5B%22past-24h%22%5D$/)
  assert.match(searchUrl('x', 'past-week'), /datePosted=%5B%22past-week%22%5D$/)
})

test('prescreen: years-of-experience only counts phrases tied to experience wording', () => {
  assert.deepEqual(prescreen('Senior Frontend Lead, 8-12 years, Riyadh. Send CV to hr@acme.sa'), [])
  assert.deepEqual(prescreen('Head of Frontend, Riyadh. We grew 3x in 2 years. CV to hr@acme.sa'), [])
  assert.deepEqual(prescreen('Requires 2+ years of experience in Vue. hr@acme.sa'), ['junior-years'])
  assert.deepEqual(prescreen('Experience: 3-5 years hands-on. hr@acme.sa'), ['junior-years'])
  assert.deepEqual(prescreen('10+ years of experience as a frontend architect. hr@acme.sa'), [])
})

test('prescreen: flags residency gates, night shifts and junior reqs', () => {
  assert.ok(prescreen('Must have transferable Iqama. hr@acme.sa').includes('residency-gate'))
  assert.ok(prescreen('US EST shift required. hr@acme.sa').includes('night-shift'))
  assert.ok(prescreen('Hiring fresh graduates. hr@acme.sa').includes('junior'))
})

test('prescreen: WordPress-only piecework is flagged, headless WordPress is not', () => {
  assert.ok(prescreen('WordPress developer needed for theme work. hr@acme.sa').includes('wordpress-only'))
  assert.ok(!prescreen('Headless WordPress with a Next.js frontend. hr@acme.sa').includes('wordpress-only'))
})

test('immediate-start is NOT a flag: Mohamed can start immediately', () => {
  assert.ok(!('immediate-start' in FLAG_RULES))
  assert.deepEqual(prescreen('Immediate joiners only. Send CV to hr@acme.sa'), [])
})

test('systemPrompt: embeds the CV and the configured titles and locations', () => {
  const p = systemPrompt('CV-MARKER-TEXT', config)
  assert.ok(p.includes('CV-MARKER-TEXT'))
  assert.ok(p.includes(config.titles[0]!))
  assert.ok(p.includes('Saudi Arabia'))
  // on-site roles outside the configured scope must be excluded, or the funnel fills with roles he
  // cannot take. This used to name Europe/UK/US literally, which was wrong the moment the scope
  // became editable — the exclusion is now stated relative to whatever is configured.
  assert.match(p, /not named above are out of scope/)
})

test('systemPrompt: the location scope tracks the configured countries, not a fixed list', () => {
  const p = systemPrompt('cv', { ...config, constraints: { ...config.constraints, onsiteCountries: ['Germany', 'Kuwait'], willRelocate: [] } })
  assert.ok(p.includes('Germany'))
  assert.ok(p.includes('Kuwait'))
  assert.ok(!p.includes('Saudi Arabia'), 'the old scope must not survive a change of countries')
  // the email-domain hint is derived, not the hardcoded '.eg .sa .ae .qa' it used to be
  assert.ok(p.includes('.de .kw'))
  assert.match(p, /will not relocate/)
})

test('systemPrompt: country aliases are inlined so the model matches post text', () => {
  // a post saying 'United Arab Emirates' and one saying 'UAE' must both land in scope
  assert.match(systemPrompt('cv', config), /UAE \(United Arab Emirates/)
})

test('systemPrompt: honours the stack weighting setting', () => {
  assert.match(systemPrompt('cv', { ...config, constraints: { ...config.constraints, stackWeighting: 'vue-primary' } }), /Vue\/Nuxt roles are the best fit/)
  assert.match(systemPrompt('cv', { ...config, constraints: { ...config.constraints, stackWeighting: 'react-primary' } }), /React\/Next roles are the best fit/)
})

// The stored settings replaced config.json; their completeness is covered by settings.test.ts,
// which can assert it against an in-memory database instead of one person's real file.
