import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ageOf, dedupeKey, extractEmails, FLAG_RULES, gateOnPostType, normalize, postedAt, postUrlFrom, prescreen,
  resolveUrls, SCORE_SCHEMA, searchUrl, systemPrompt, tokenFromId, urnMap
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

// The three below are the real stored text of the posts that scored 7/10 and sat at the top of the drafter
// queue: other frontend engineers advertising themselves. A peer's self-description is the best possible
// match for this CV, which is exactly why scoring alone could never catch them.
test('prescreen: a developer advertising themselves is flagged as seeking-work', () => {
  // typographic apostrophe, and the hashtag form with no separators
  assert.ok(prescreen('\u{1F680} I’m #OpenToWork and looking for my next opportunity as a Senior Front-End Developer. hello@example.dev').includes('seeking-work'))
  // ASCII apostrophe
  assert.ok(prescreen('Hi connections! I\'m actively seeking my next role as a Senior Software Engineer. me@example.com').includes('seeking-work'))
  // the freelancer pitch, which carries no "open to work" wording at all
  assert.ok(prescreen('I\'m Usman, a Senior Frontend Engineer. Services I offer:\n→ Frontend development. me@example.com').includes('seeking-work'))
})

// The load-bearing case: this is a genuine DecipherZone vacancy posted by someone whose own LinkedIn
// headline ends "| Open to Work". The scored text includes the card header, so a bare /open to work/ rule
// would bury a real job. Requiring the first person is what separates the two.
test('prescreen: seeking-work is first person, so a real req from an "Open to Work" author survives', () => {
  const realReq = 'Rajesh Vankam\n\nJava Backend Developer | Spring Boot • REST APIs | Open to Work\n\n16h\n\nFollow\n\n#Hiring \u{1F680} We’re Hiring | Frontend Developer\n\nDecipherZone Technologies is looking for talented Frontend Developers. careers@decipherzone.com'
  assert.ok(!prescreen(realReq).includes('seeking-work'))
  // and a recruiter offering their own time is not seeking work either
  assert.ok(!prescreen('We are hiring a Senior Vue Developer. I am available for any questions. hr@acme.sa').includes('seeking-work'))
})

// Measured, not assumed: across five rescores of the same 21 stored posts the classification never moved,
// while the score the prompt tells the model to pin at 0 did. Hence the arithmetic lives in code.
test('gateOnPostType: a non-hiring post cannot keep a score or a location verdict', () => {
  const seeker = { post_type: 'seeking', score: 8, is_remote: true, is_in_scope: true, title: 'Senior Frontend Engineer' }
  assert.deepEqual(gateOnPostType(seeker), { post_type: 'seeking', score: 0, is_remote: false, is_in_scope: false, title: 'Senior Frontend Engineer' })
  // 'other' is gated the same way — a security advisory is not a job either
  assert.equal(gateOnPostType({ post_type: 'other', score: 6, is_remote: true, is_in_scope: true }).score, 0)
  // a hiring post passes through untouched, object identity included
  const job = { post_type: 'hiring', score: 9, is_remote: true, is_in_scope: true }
  assert.equal(gateOnPostType(job), job)
})

test('SCORE_SCHEMA: post_type is required, because strict mode gives the model no other way to say it', () => {
  assert.ok(SCORE_SCHEMA.required.includes('post_type'))
  assert.deepEqual(SCORE_SCHEMA.properties.post_type.enum, ['hiring', 'seeking', 'other'])
  // every property must be listed in `required` or the Responses API rejects a strict schema
  assert.deepEqual([...SCORE_SCHEMA.required].sort(), Object.keys(SCORE_SCHEMA.properties).sort())
})

test('systemPrompt: post_type is defined AFTER the scoring rules, and that order is load-bearing', () => {
  const p = systemPrompt('CV-MARKER-TEXT', config)
  assert.match(p, /post_type — who is posting/)
  assert.match(p, /"seeking": the author is advertising themselves/)
  // An author whose headline says "Open to Work" can still be posting a real vacancy; the prompt has to
  // say so, or a genuine req is classified by its poster's job hunt.
  assert.match(p, /may still be posting a real vacancy/)
  // The order is the finding, not a preference: with post_type stated first, out-of-scope on-site roles
  // went from 0-2 to 7 across two rescores of the stored posts — the location rule lost its position at
  // the top of the prompt. post_type is appended so every rule that was tuned above it keeps its place.
  assert.ok(
    p.indexOf('not named above are out of scope') < p.indexOf('post_type — who is posting'),
    'the location scope rule must precede the post_type block'
  )
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

// ---------------- post permalinks ----------------

test('a card id yields its post token, in either expanded state', () => {
  const tok = 'W8muNvdII1bJGTDSGso9kVJPJmx0ylFVm5PrAqphQZI'
  assert.equal(tokenFromId(`expanded${tok}FeedType_FLAGSHIP_SEARCH`), tok)
  assert.equal(tokenFromId(`collapsed${tok}FeedType_MAIN_FEED_RELEVANCE`), tok)
  // ids that are not a card's: short posts have no expander at all, and cards carry plenty of other ids
  assert.equal(tokenFromId('person-accent-4'), null)
  assert.equal(tokenFromId(null), null)
  assert.equal(tokenFromId(undefined), null)
})

test('urnMap pairs each card token with the URN that precedes its UpdateState key', () => {
  // the shape a search payload has: one state block per card, the post's own URN just before its key
  const body = '"id":"reactionState-urn:li:activity:111"}},"id":"UpdateState' + 'A'.repeat(24)
    + '"}},"id":"reactionState-urn:li:ugcPost:222"}},"id":"UpdateState' + 'B'.repeat(24) + '"}}'
  assert.deepEqual([...urnMap(body)], [['A'.repeat(24), 'urn:li:activity:111'], ['B'.repeat(24), 'urn:li:ugcPost:222']])
  assert.equal(urnMap('nothing here').size, 0)
})

test('a post URN becomes a permalink, and anything else becomes null', () => {
  assert.equal(postUrlFrom('urn:li:activity:7503713927348764672'),
    'https://www.linkedin.com/feed/update/urn:li:activity:7503713927348764672/')
  assert.equal(postUrlFrom('urn:li:ugcPost:7503685320660590592'),
    'https://www.linkedin.com/feed/update/urn:li:ugcPost:7503685320660590592/')
  assert.equal(postUrlFrom('urn:li:member:12345'), null)
  assert.equal(postUrlFrom('javascript:alert(1)'), null)
  assert.equal(postUrlFrom(null), null)
  // the matcher must not be a stateful global regex: the same input twice must answer the same twice
  assert.equal(postUrlFrom('urn:li:activity:1'), postUrlFrom('urn:li:activity:1'))
})

test('a URN two cards both claim is dropped rather than linked to the wrong post', () => {
  const urns = new Map([['A'.repeat(24), 'urn:li:activity:111'], ['B'.repeat(24), 'urn:li:activity:111'],
    ['C'.repeat(24), 'urn:li:activity:333']])
  const id = (t: string) => `expanded${t}FeedType_FLAGSHIP_SEARCH`
  assert.deepEqual(
    resolveUrls([id('A'.repeat(24)), id('B'.repeat(24)), id('C'.repeat(24)), id('D'.repeat(24)), null], urns),
    [null, null, 'https://www.linkedin.com/feed/update/urn:li:activity:333/', null, null]
  )
})
