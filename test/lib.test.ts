import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  admits, ageOf, applyCueFor, applyCueNear, channelsOf, dedupeKey, extractEmails, extractLinks, extractPhones, extractRefIds, legacyKey, storedKey,
  excludeRule, fieldRule, FLAG_RULES, gateOnPostType, hasApplyCue, isThrottled, normalize, postedAt, postUrlFrom, prescreen, rotateTerms, throttleEvidence,
  keepScrolling, resolveUrls, SCORE_SCHEMA, SCROLL_STALL_MS, searchUrl, skillRule, systemPrompt, tokenFromId, urnMap
} from '../scraper/lib.ts'
import type { Config } from '../scraper/lib.ts'
import { emptySettings } from '../shared/settings.ts'

// A fixture, not the stored settings: these assert what systemPrompt DOES with a config, which must
// hold for any config, and a test that reads one person's settings cannot run on a fresh clone.
const config: Config = {
  ...emptySettings(),
  // `location` is load-bearing for the flag rules now: it is where the home country comes from, and
  // a gate is only a gate somewhere you do not already live.
  profile: { ...emptySettings().profile, location: 'Cairo, Egypt' },
  constraints: {
    ...emptySettings().constraints,
    onsiteCountries: ['Egypt', 'Saudi Arabia', 'UAE', 'Qatar'],
    willRelocate: ['Saudi Arabia', 'UAE', 'Qatar']
  },
  scope: {
    roleFamily: 'frontend engineering',
    primarySkills: ['Vue', 'Nuxt'],
    secondarySkills: ['React', 'Next.js'],
    excludedRoles: ['pure UI/UX design', 'pure backend'],
    seniorityFloor: 5
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

// Measured 2026-09-18 over the 655 stored posts that carry a Follow marker: the header alone fills
// p50=87, p90=195, max=1605 chars of the 160-char window, and 119 of them leave ZERO body characters
// in the key. Every post by such an author hashes identically, so the second one is dropped as a
// duplicate it never was. Found live: two different posts by one author both keyed to one hash.
test('dedupeKey: a long headline must not swallow the window, or one author keys as one post', () => {
  // 176 chars once stripped, so under the old rule not one body character reached the hash
  const header = 'Feed post\nA Consultant, MBA, PMP\n • 3rd+\n'
    + 'Leading complex digital transformations by turning data, AI, cloud and ERP strategies into measurable business outcomes for enterprise clients\n'
    + '1h • \nFollow\n'
  const a = dedupeKey('u', header + 'Hiring a .NET lead in Cairo. Apply: https://lnkd.in/aaa')
  const b = dedupeKey('u', header + 'Hiring a data engineer in Dubai. Apply: https://lnkd.in/bbb')
  assert.notEqual(a, b)
})

// Changing keyText re-keys every stored row, so without this a re-scrape would store a second copy of
// every post still inside `since`. Re-keying the rows instead is not the cheaper option: applications.key
// references posts.key ON UPDATE NO ACTION.
test('storedKey: a post already held under the pre-change key is recognised, not stored again', () => {
  const text = 'Feed post\nHeba Zaki\n • 2nd\nTalent Acquisition\n21h • \nFollow\nWe are hiring a Vue lead. Send CV to hr@x.com'
  const old = legacyKey('u', text)
  assert.notEqual(old, dedupeKey('u', text)) // the change really did move the key
  // the row on disk carries the old key, so that is the key the caller must reuse
  assert.equal(storedKey(new Set([old]), 'u', text), old)
  assert.equal(storedKey(new Set([dedupeKey('u', text)]), 'u', text), dedupeKey('u', text))
  assert.equal(storedKey(new Set(), 'u', text), null)
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

test('excludeRule: an empty list produces no rule at all', () => {
  // Fails OPEN, like every rule in flagRules(). The alternative is /(?:)/, which matches every post
  // and would silently empty the drafter queue the first time someone cleared the list.
  assert.equal(excludeRule([]), null)
  assert.equal(excludeRule(['', '   ']), null)
})

test('excludeRule: whole words, so a short needle cannot eat the corpus', () => {
  // Measured over the 42 stored posts: bare `ai` matched 36 of them, 9 with boundaries. That gap is
  // the whole reason this rule is not a substring match.
  assert.equal(excludeRule(['ai'])!.test('send your cv by email'), false)
  assert.equal(excludeRule(['ai'])!.test('an AI role, remote'), true)
  assert.equal(excludeRule(['intern'])!.test('Internix.io is hiring'), false)
  assert.equal(excludeRule(['intern'])!.test('paid intern wanted'), true)
})

test('excludeRule: a boundary is only added where \\b can see it', () => {
  // \b is ASCII-only in a JS regex, so wrapping these would stop them matching anything at all —
  // the same trap extractPhones documents for its Arabic cues.
  assert.equal(excludeRule(['C#'])!.test('strong C# skills'), true)
  assert.equal(excludeRule(['مطلوب'])!.test('مطلوب مهندس'), true)
  assert.equal(excludeRule(['.net'])!.test('a .net shop'), true)
})

test('excludeRule: a needle is a literal, never a pattern', () => {
  // The list is typed by hand, so a stray metacharacter must not silently widen the rule.
  assert.equal(excludeRule(['c++'])!.test('c++ developer'), true)
  assert.equal(excludeRule(['c++'])!.test('c developer'), false)
  assert.equal(excludeRule(['a|b'])!.test('a shop'), false)
  assert.equal(excludeRule(['(test)'])!.test('a test'), false)
})

test('excludeRule: a domain written in the prose is what actually matches', () => {
  // LinkedIn rewrites the href to an opaque lnkd.in hash, so the readable name only ever survives in
  // the post text. This is the real shape of the case the feature was built for.
  const re = excludeRule(['micro1.ai'])!
  assert.equal(re.test('Apply here: https://lnkd.in/abc\n\njobs.micro1.ai'), true)
  assert.equal(re.test('MICRO1.AI is hiring'), true, 'case-insensitive')
  assert.equal(re.test('micro2.ai is hiring'), false)
})

test('prescreen: the exclude list becomes the `excluded` flag, and only when it is set', () => {
  const post = 'Frontend Engineer, remote. Apply: jobs.micro1.ai'
  assert.deepEqual(prescreen(post, config), [], 'no rules configured, no flag')
  const excluding = { ...config, excludes: ['micro1.ai'] }
  assert.deepEqual(prescreen(post, excluding), ['excluded'])
  // and it rides alongside the derived rules rather than replacing them
  const both = prescreen('Hiring fresh graduates at micro1.ai', excluding)
  assert.ok(both.includes('excluded') && both.includes('junior'))
})

test('prescreen: years-of-experience only counts phrases tied to experience wording', () => {
  assert.deepEqual(prescreen('Senior Frontend Lead, 8-12 years, Riyadh. Send CV to hr@acme.sa', config), [])
  assert.deepEqual(prescreen('Head of Frontend, Riyadh. We grew 3x in 2 years. CV to hr@acme.sa', config), [])
  assert.deepEqual(prescreen('Requires 2+ years of experience in Vue. hr@acme.sa', config), ['junior-years'])
  assert.deepEqual(prescreen('Experience: 3-5 years hands-on. hr@acme.sa', config), ['junior-years'])
  assert.deepEqual(prescreen('10+ years of experience as a frontend architect. hr@acme.sa', config), [])
})

test('prescreen: the seniority floor drives both junior rules, and 0 turns them off', () => {
  // Someone whose floor is unset IS in the market these postings serve. Flagging them would remove
  // every suitable post from their drafter queue, which is the opposite of what a hint is for.
  const graduate = { ...config, scope: { ...config.scope, seniorityFloor: 0 } }
  assert.deepEqual(prescreen('Requires 2+ years of experience. hr@acme.sa', graduate), [])
  assert.deepEqual(prescreen('Hiring fresh graduates. hr@acme.sa', graduate), [])
  // and a higher floor catches more
  const principal = { ...config, scope: { ...config.scope, seniorityFloor: 8 } }
  assert.ok(prescreen('Requires 7 years of experience. hr@acme.sa', principal).includes('junior-years'))
})

test('prescreen: flags residency gates, night shifts and junior reqs', () => {
  assert.ok(prescreen('Must have transferable Iqama. hr@acme.sa', config).includes('residency-gate'))
  assert.ok(prescreen('US EST shift required. hr@acme.sa', config).includes('night-shift'))
  assert.ok(prescreen('Hiring fresh graduates. hr@acme.sa', config).includes('junior'))
  assert.ok(prescreen('Nationals only. hr@acme.sa', config).includes('residency-gate'))
})

test('a residency gate is only a gate somewhere you do not already live', () => {
  // "UAE-based candidates only" excludes a Cairo-based applicant. The same sentence about Egypt does
  // not — and onsiteCountries contains Egypt, so deriving straight from that list would have flagged
  // every posting in this person's own city.
  assert.ok(prescreen('UAE-based candidates only. hr@acme.sa', config).includes('residency-gate'))
  assert.ok(!prescreen('Egypt-based candidates only. hr@acme.sa', config).includes('residency-gate'))
  // and a US-hours post is not a night shift for someone living in the US
  const us = { ...config, profile: { ...config.profile, location: 'Austin, United States' } }
  assert.ok(!prescreen('US EST shift required. hr@acme.sa', us).includes('night-shift'))
  assert.ok(prescreen('IST timings required. hr@acme.sa', us).includes('night-shift'))
})

test('a home country that cannot be resolved fails open rather than flagging everything', () => {
  const vague = { ...config, profile: { ...config.profile, location: 'remote' } }
  // no country clause is emitted at all; the generic half still works
  assert.ok(prescreen('Must have transferable Iqama. hr@acme.sa', vague).includes('residency-gate'))
})

test('immediate-start is NOT a flag: it is not universally a negative', () => {
  // Whether an immediate start is good or bad is a property of the candidate, not of the posting, and
  // the drafter already states the real availability from the injected constraints.
  assert.ok(!('immediate-start' in FLAG_RULES))
  assert.deepEqual(prescreen('Immediate joiners only. Send CV to hr@acme.sa', config), [])
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

test('systemPrompt: the weighting is composed from the configured skills, not a fixed stack', () => {
  // The Vue-vs-React enum this replaced could only ever describe one person's trade.
  const engineer = {
    ...config,
    titles: ['Senior Structural Engineer', 'Bridge Design Engineer'],
    scope: {
      ...config.scope, roleFamily: 'structural engineering',
      primarySkills: ['ETABS', 'SAP2000'], secondarySkills: ['Revit'],
      excludedRoles: ['architectural drafting']
    }
  }
  const p = systemPrompt('cv', engineer)
  assert.match(p, /Roles built on ETABS, SAP2000 are the best fit and score highest/)
  assert.match(p, /Roles built on Revit score well, but one point lower/)
  assert.match(p, /The candidate's field is structural engineering/)
  assert.match(p, /architectural drafting roles score 0-2/)
  assert.ok(!/Vue|React|frontend/i.test(p), 'no stack may survive a change of skills')
})

test('systemPrompt: an unset skill or field emits no rule rather than a rule with a hole in it', () => {
  const blank = systemPrompt('cv', emptySettings())
  assert.ok(!blank.includes('undefined'))
  assert.ok(!/Roles built on \./.test(blank))
  assert.ok(!/The candidate's field is \./.test(blank))
  assert.ok(!/\n\n\n/.test(blank), 'a dropped clause must not leave a blank line behind')
  // and the ordering that matters still holds on a fresh install
  assert.ok(blank.indexOf('not named above are out of scope') < blank.indexOf('post_type — who is posting'))
})

test('skillRule and fieldRule each drop the clause whose setting is empty', () => {
  assert.equal(skillRule({ ...config.scope, primarySkills: [], secondarySkills: [] }), '')
  assert.equal(fieldRule({ ...config.scope, roleFamily: '' }), '')
  assert.ok(!fieldRule({ ...config.scope, excludedRoles: [] }).includes('In particular'))
  assert.ok(!skillRule({ ...config.scope, secondarySkills: [] }).includes('one point lower'))
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

// ---------------- contact channels ----------------
// Every phone number below is deliberately fake (a zeroed subscriber part). test/ is outside the
// surface identity.test.ts scans, which is exactly why a fixture may look like a real detail — but a
// fixture that could be somebody's actual number is how you get a support request instead of a test.

test('extractLinks: keeps external links, drops LinkedIn chrome', () => {
  // author, company and hashtag anchors are all linkedin.com and are not application links
  const hrefs = [
    'https://www.linkedin.com/in/someone',
    'https://www.linkedin.com/company/acme',
    'https://www.linkedin.com/feed/hashtag/hiring',
    'https://lnkd.in/eAbCdEfG'
  ]
  assert.deepEqual(extractLinks('', hrefs), ['https://lnkd.in/eAbCdEfG'])
})

test('extractLinks: reads the text too, and merges with the DOM hrefs', () => {
  const text = 'Apply here: https://lnkd.in/eAbCdEfG and see https://acme.example/careers'
  assert.deepEqual(
    extractLinks(text, ['https://lnkd.in/eAbCdEfG']),
    ['https://lnkd.in/eAbCdEfG', 'https://acme.example/careers']
  )
})

test('extractLinks: strips punctuation innerText glues to the end', () => {
  assert.deepEqual(extractLinks('see https://acme.example/jobs.'), ['https://acme.example/jobs'])
  assert.deepEqual(extractLinks('(https://acme.example/jobs)'), ['https://acme.example/jobs'])
  assert.deepEqual(extractLinks('link: https://acme.example/jobs, then'), ['https://acme.example/jobs'])
})

test('extractLinks: nothing to find is an empty array, not a null', () => {
  assert.deepEqual(extractLinks('no links at all here'), [])
})

test('extractPhones: takes an international number and normalises the separators away', () => {
  assert.deepEqual(extractPhones('Reach me on +20 100 000 0000 any time'), ['+201000000000'])
  assert.deepEqual(extractPhones('call +971-50-000-0000'), ['+971500000000'])
  assert.deepEqual(extractPhones('WhatsApp: +(966) 50 000 0000'), ['+966500000000'])
})

test('extractPhones: a local number needs a contact cue to count', () => {
  assert.deepEqual(extractPhones('WhatsApp 01000000000 for details'), ['01000000000'])
  assert.deepEqual(extractPhones('واتساب 01000000000'), ['01000000000'])
  // the same digits with nothing calling them a phone number are not one
  assert.deepEqual(extractPhones('order reference 01000000000 was shipped'), [])
})

test('extractPhones: numbers that are not phone numbers stay out', () => {
  assert.deepEqual(extractPhones('5-7 years of experience, salary 15000 EGP, posted 2026'), [])
  assert.deepEqual(extractPhones('Call us for 5 roles'), [])
  assert.deepEqual(extractPhones('budget is 50,000 - 70,000 per month'), [])
})

test('extractPhones: picks a number out of a wa.me link', () => {
  assert.deepEqual(extractPhones('', ['https://wa.me/201000000000']), ['+201000000000'])
})

test('extractPhones: dedupes the same number written two ways', () => {
  assert.deepEqual(extractPhones('+20 100 000 0000 or +201000000000'), ['+201000000000'])
})

test('extractRefIds: only an explicitly labelled identifier', () => {
  assert.deepEqual(extractRefIds('Job ID: REQ-4821 — apply now'), ['REQ-4821'])
  assert.deepEqual(extractRefIds('Requisition Code JR00123'), ['JR00123'])
  assert.deepEqual(extractRefIds('quote ref: 2026-DEV-11'), ['2026-DEV-11'])
})

test('extractRefIds: the words that look like a label are not one', () => {
  // the loose version of this regex returned 'Requirements', 'required', 'Position: Frontend'
  assert.deepEqual(extractRefIds('Requirements: 5 years. Position: Frontend. Skills required.'), [])
  assert.deepEqual(extractRefIds('This job requires a portfolio'), [])
})

test('hasApplyCue: fires on prose that points at a link, in either language', () => {
  for (const t of ['Apply here', 'apply now', 'Application link below', 'To apply, use the link',
    'Click here to register', 'Submit your CV through the portal', 'للتقديم من خلال الرابط']) {
    assert.equal(hasApplyCue(t), true, t)
  }
})

test('hasApplyCue: does not fire on a vendor pitch that merely has a link', () => {
  // all seven link-bearing posts in the stored corpus read like these, and none was an application link
  for (const t of ['Tell us what engineers you need and we will send a talent overview within 48 hours.',
    'You can find the blog post here:', 'Take the free Hire Match Test and discover what fits.',
    'We will show you what India via EOR can deliver in 4 weeks.']) {
    assert.equal(hasApplyCue(t), false, t)
  }
})

test('channelsOf: a link only counts as a channel when the prose invites an application', () => {
  const link = ['https://lnkd.in/eAbCdEfG']
  assert.deepEqual(channelsOf({ emails: [], links: link, phones: [] }, 'Apply here for the role'), ['link'])
  assert.deepEqual(channelsOf({ emails: [], links: link, phones: [] }, 'Read our blog post here'), [])
})

test('channelsOf: returns every channel present, in a fixed order', () => {
  const all = channelsOf(
    { emails: ['hr@acme.example'], links: ['https://lnkd.in/eAbCdEfG'], phones: ['+201000000000'] },
    'Apply here or email us'
  )
  assert.deepEqual(all, ['email', 'link', 'phone'])
})

test('channelsOf: an email alone is still the ordinary case', () => {
  assert.deepEqual(channelsOf({ emails: ['hr@acme.example'], links: [], phones: [] }, 'send your CV'), ['email'])
})

test('admits: a post is kept when any channel it carries is switched on', () => {
  assert.equal(admits(['email'], ['email']), true)
  assert.equal(admits(['link'], ['email']), false)
  assert.equal(admits(['email', 'link'], ['link']), true)
  // an empty admission set admits nothing — missingFields() is what stops a scrape starting that way
  assert.equal(admits(['email'], []), false)
  assert.equal(admits([], ['email', 'link', 'phone']), false)
})

test('applyCueNear: a cue far from the link does not point at it', () => {
  const link = 'https://acme.example/blog'
  assert.equal(applyCueNear(`How to apply: send your details. ${link}`, link), true)
  const far = `writers need to apply separately to the other programme. ${'context. '.repeat(60)}read the blog post here: ${link}`
  assert.equal(applyCueNear(far, link), false)
})

test('applyCueNear: a link the text never renders falls back to the whole post', () => {
  // a DOM-only anchor has no position to measure against
  assert.equal(applyCueNear('To apply, use the button', 'https://acme.example/x'), true)
  assert.equal(applyCueNear('Read our blog', 'https://acme.example/x'), false)
})

test('channelsOf: a post that discusses applying but links a blog is not a link route', () => {
  // shaped on the BBC Writers post in the stored corpus, which the whole-text version admitted
  const link = 'https://lnkd.in/eAbCdEfG'
  const text = `DDN writers no longer need to apply separately to both programmes. ${'context. '.repeat(60)}You can find the blog post here: ${link}`
  assert.deepEqual(channelsOf({ emails: [], links: [link], phones: [] }, text), [])
})

test('channelsOf: an apply cue a sentence before the link does point at it', () => {
  // shaped on the one genuine apply link in the corpus: an 'or <link>' alternative to the email route
  const link = 'https://lnkd.in/gKFzEnpK'
  const text = `How to Apply: if you are interested, drop your CV to hr@acme.example with the subject Name - Job Position, or ${link}`
  assert.deepEqual(channelsOf({ emails: [], links: [link], phones: [] }, text), ['link'])
})

test('applyCueFor names the cue that admitted a link, for tuning against real cards', () => {
  const link = 'https://acme.example/x'
  assert.equal(applyCueFor(`How to Apply: details here. ${link}`, link), 'to Apply')
  assert.equal(applyCueFor(`Read our blog post. ${link}`, link), null)
})

test('extractPhones: "send your CV to <number>" is a contact cue, with no word for a phone anywhere', () => {
  // Measured live 2026-09-17 on the "senior .net developer" search: a score-7 Xceed post read "send your
  // resume to <number>" and extracted nothing, so the post carried no contact route at all and was
  // dropped. PHONE_CUED wanted a NOUN for a phone (whatsapp/mobile/tel/call/contact); recruiters in Egypt
  // routinely post a WhatsApp number with this phrasing instead. Proven with a control on one number:
  // "contact <n>" extracted it, "send your resume to <n>" did not.
  assert.deepEqual(extractPhones('send your resume to 01000000000 and mention the role'), ['01000000000'])
  assert.deepEqual(extractPhones('Share your CV on 01000000000'), ['01000000000'])
  assert.deepEqual(extractPhones('drop your cv via 01000000000'), ['01000000000'])
})

test('extractPhones: the send-CV cue still refuses salaries, year ranges and dates', () => {
  // This cue is looser than the phone nouns, so the guard that keeps digit runs out has to hold with it.
  // A connector (to/on/via/at) must sit immediately before the number: without that, "share your cv,
  // salary 15000 - 20000 EGP" reads as a ten-digit phone number.
  assert.deepEqual(extractPhones('share your cv, salary 15000 - 20000 EGP'), [])
  assert.deepEqual(extractPhones('send your CV to careers@acme.com and note 5-7 years of experience'), [])
  assert.deepEqual(extractPhones('send your resume before 15 January 2026'), [])
})

test('keepScrolling: patience is wall clock, not a count of iterations', () => {
  // The old rule gave up after 4 iterations of a 2-5s sleep — as little as 8 seconds of no growth. One
  // measured feed run stopped at 28 cards; the next, minutes later, found 58 on the same feed.
  assert.equal(keepScrolling(10, 50, 0), true, 'below the cap, just grew')
  assert.equal(keepScrolling(10, 50, 9_000), true, 'a nine-second lull is lazy-loading, not the end')
  assert.equal(keepScrolling(10, 50, SCROLL_STALL_MS), false, 'a sustained stall is the end')
  assert.equal(keepScrolling(50, 50, 0), false, 'the card cap always wins')
})

test('isThrottled: LinkedIn pausing search is not an empty result', () => {
  // Measured 2026-09-17: six configured terms returned zero cards in one afternoon, each leaving a
  // logs/zero-*.png reading "Our systems have detected unusual search traffic coming from your account".
  // The same terms had returned 15-20 posts each that morning. The URL stays on /search/results/content/,
  // so the /checkpoint/ guard never fires: the run logged "0 cards", moved to the next term and kept
  // hammering an account that had already been asked to stop.
  assert.equal(isThrottled('Our systems have detected unusual search traffic coming from your account'), true)
  assert.equal(isThrottled('search activity on your account has been paused. Try again later.'), true)
  // a genuinely empty result, and an ordinary post, must not read as a throttle
  assert.equal(isThrottled('No results found'), false)
  assert.equal(isThrottled('Senior .NET Developer — we are hiring, send your CV'), false)
})

test('rotateTerms: the tail of the list must not starve forever', () => {
  // Measured 2026-09-19: two runs both aborted at term 4 of 17 when LinkedIn paused search, and terms
  // 5-17 had never run at all — not once, because the list is scanned top-down and the budget is spent
  // before it reaches them. A fixed order does not lose a random share of coverage, it loses the SAME
  // bottom share every day.
  const terms = ['feed', 'a', 'b', 'c', 'd']
  assert.deepEqual(rotateTerms(terms, 0), ['feed', 'a', 'b', 'c', 'd'])
  assert.deepEqual(rotateTerms(terms, 1), ['feed', 'b', 'c', 'd', 'a'])
  assert.deepEqual(rotateTerms(terms, 3), ['feed', 'd', 'a', 'b', 'c'])
  // wraps, and a day count far from zero is still in range
  assert.deepEqual(rotateTerms(terms, 4), rotateTerms(terms, 0))
  assert.deepEqual(rotateTerms(terms, 20_000), rotateTerms(terms, 20_000 % 4))
})

test('rotateTerms: feed stays first, because it is not a search', () => {
  // The pause counts SEARCH activity — the evidence page says so in as many words — and `feed` reads
  // linkedin.com/feed/, not /search/results/content/. Rotating it into the tail would forfeit the
  // highest-volume source to a budget it never spent.
  for (const day of [0, 1, 2, 3, 7, 100]) {
    assert.equal(rotateTerms(['feed', 'a', 'b', 'c'], day)[0], 'feed', `day ${day} moved feed`)
  }
})

test('rotateTerms: every term reaches the front within one cycle', () => {
  // The whole point. If some term can never be first, rotation has not fixed the starvation.
  const terms = ['feed', 'a', 'b', 'c', 'd', 'e']
  const firstSearch = new Set(Array.from({ length: 5 }, (_, d) => rotateTerms(terms, d)[1]))
  assert.deepEqual([...firstSearch].sort(), ['a', 'b', 'c', 'd', 'e'])
})

test('rotateTerms: degenerate lists do not throw', () => {
  assert.deepEqual(rotateTerms([], 3), [])
  assert.deepEqual(rotateTerms(['feed'], 3), ['feed'])
  assert.deepEqual(rotateTerms(['a'], 3), ['a'])
  assert.deepEqual(rotateTerms(['a', 'b'], -1), ['b', 'a'], 'a negative day must not produce a hole')
})

test('throttleEvidence: an abort has to leave something a human can check', () => {
  // A run-ending decision that saves no evidence cannot be audited afterwards. Measured 2026-09-19: the
  // scraper aborted four terms in with exit 3, the account searched fine by hand minutes later, and there
  // was no way to tell a real throttle that had since cleared from a false positive — the branch read the
  // page text, tested it, and discarded it.
  const page = 'Results  Our systems have detected unusual search traffic coming from your account. '
    + 'Please try again later.  Try searching for something else'
  const found = throttleEvidence(page)
  assert.ok(found, 'a throttled page must yield evidence')
  assert.match(found!, /unusual search traffic/, 'the evidence must contain the phrase that fired')
  assert.ok(found!.length > 'unusual search traffic'.length, 'the phrase alone is not enough context to judge it')
  assert.equal(throttleEvidence('No results found'), null, 'an empty result is not a throttle')
})

test('throttleEvidence and isThrottled cannot disagree', () => {
  // Two copies of the same rule drift, and the pair that drifts here aborts a healthy run or misses a real
  // pause. Every case the suite pins for one must give the same verdict from the other.
  for (const [text, throttled] of [
    ['Our systems have detected unusual search traffic coming from your account', true],
    ['search activity on your account has been paused. Try again later.', true],
    ['No results found', false],
    ['Senior .NET Developer — we are hiring, send your CV', false]
  ] as [string, boolean][]) {
    assert.equal(isThrottled(text), throttled, `isThrottled disagrees on: ${text.slice(0, 40)}`)
    assert.equal(throttleEvidence(text) !== null, throttled, `throttleEvidence disagrees on: ${text.slice(0, 40)}`)
  }
})
