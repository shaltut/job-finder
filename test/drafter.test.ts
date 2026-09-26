import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PROMPT_BUDGET, PROMPT_SEPARATOR, buildSystemPrompt, candidateBlock, checkContract, fitsPromptBudget, parseResponse,
  profileBlock, readProcedure, type DraftRequest
} from '../server/utils/drafter.ts'
import { MASTER_CV_HEADING, assignIds } from '../server/utils/cv-master.ts'
import { emptySettings, type StoredSettings as AppConfig } from '../shared/settings.ts'

// A fixture, not the stored settings. These assert what profileBlock does with a config, which must
// hold for any config; reading one person's real settings would also stop this running on a clone.
const config: AppConfig = {
  ...emptySettings(),
  profile: {
    name: 'Test Person', title: 'Senior Frontend Engineer', location: 'Cairo, Egypt',
    email: 'test@example.com', phone: '+20 100 000 0000',
    linkedin: 'https://www.linkedin.com/in/test-person', github: 'https://github.com/testperson',
    languages: 'Arabic native, English professional', yearsExperience: '10+'
  },
  constraints: {
    ...emptySettings().constraints,
    onsiteCountries: ['Egypt', 'Saudi Arabia', 'UAE', 'Qatar'],
    willRelocate: ['Saudi Arabia', 'UAE', 'Qatar'],
    workingHours: '09:00-21:00 Africa/Cairo'
  },
  cv: 'data/cv/test.pdf',
  terms: ['feed'],
  titles: ['Senior Frontend Engineer']
}

const req: DraftRequest = {
  mode: 'apply',
  recruiterEmail: 'hr@acme.sa',
  posts: [
    { key: 'a'.repeat(40), title: 'Senior Frontend Engineer', company: 'Acme', location: 'Riyadh', score: 9, flags: [], text: 'hiring' },
    { key: 'b'.repeat(40), title: 'Frontend Lead', company: 'Acme', location: 'Riyadh', score: 7, flags: [], text: 'hiring too' }
  ]
}

const ok = {
  results: [
    { key: 'a'.repeat(40), verdict: 'drafted', reason: 'named in application; Vue depth', subject: 'S', body: 'B' },
    { key: 'b'.repeat(40), verdict: 'drafted', reason: 'named in application; same recruiter' }
  ],
  report: 'fine'
}

test('parseResponse accepts raw JSON', () => {
  const r = parseResponse(JSON.stringify(ok))
  assert.equal(r.results.length, 2)
  assert.equal(r.report, 'fine')
})

test('parseResponse survives a ```json fence and surrounding prose', () => {
  assert.equal(parseResponse('```json\n' + JSON.stringify(ok) + '\n```').results.length, 2)
  assert.equal(parseResponse('Here you go:\n' + JSON.stringify(ok) + '\nHope that helps!').results.length, 2)
})

test('parseResponse rejects output with no JSON at all', () => {
  assert.throws(() => parseResponse('I cannot help with that.'), /no JSON object/)
})

test('parseResponse rejects a result missing required fields', () => {
  assert.throws(() => parseResponse(JSON.stringify({ results: [{ key: 'x', verdict: 'drafted' }] })))
})

test('parseResponse rejects an unknown verdict', () => {
  assert.throws(() => parseResponse(JSON.stringify({ results: [{ key: 'x', verdict: 'maybe', reason: 'r' }] })))
})

test('checkContract passes a well-formed response', () => {
  assert.deepEqual(checkContract(req, parseResponse(JSON.stringify(ok))), [])
})

test('checkContract catches a post left without a verdict', () => {
  const partial = { results: [ok.results[0]], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(partial)))
  assert.ok(problems.some(p => p.includes('no verdict returned')), problems.join('; '))
})

test('checkContract catches a verdict for a post that was never requested', () => {
  const extra = { results: [...ok.results, { key: 'c'.repeat(40), verdict: 'skipped', reason: 'nope' }], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(extra)))
  assert.ok(problems.some(p => p.includes('not requested')), problems.join('; '))
})

test('checkContract enforces the load-bearing "named in application" prefix', () => {
  // the follow-up query finds unmentioned posts by this prefix; without it they would be emailed twice
  const bad = { results: [{ ...ok.results[0], reason: 'looks good' }, ok.results[1]], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(bad)))
  assert.ok(problems.some(p => p.includes('named in application')), problems.join('; '))
})

test('checkContract expects "named in follow-up" in follow-up mode', () => {
  const problems = checkContract({ ...req, mode: 'follow-up' }, parseResponse(JSON.stringify(ok)))
  assert.ok(problems.some(p => p.includes('named in follow-up')), problems.join('; '))
})

test('checkContract refuses two emails to one recruiter', () => {
  const two = { results: [ok.results[0], { ...ok.results[1], subject: 'S2', body: 'B2' }], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(two)))
  assert.ok(problems.some(p => p.includes('more than one post carries an email body')), problems.join('; '))
})

test('checkContract catches a body with no subject', () => {
  const noSubject = { results: [{ ...ok.results[0], subject: undefined }, ok.results[1]], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(noSubject)))
  assert.ok(problems.some(p => p.includes('no subject')), problems.join('; '))
})

test('checkContract catches a duplicated key', () => {
  const dup = { results: [ok.results[0], ok.results[0]], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(dup)))
  assert.ok(problems.some(p => p.includes('duplicate')), problems.join('; '))
})

// Pressing Draft is the owner's judgement and the drafter does not get to overrule it. Code, not only
// procedure: the model follows a written instruction most of the time, and a chosen skip used to be
// logged as "passed over" — the press did nothing, and said so only in the job log.
const declined = {
  results: [ok.results[0], { key: 'b'.repeat(40), verdict: 'skipped', reason: 'below the seniority floor' }],
  report: ''
}

test('checkContract refuses a skip on a post the owner chose by hand', () => {
  const problems = checkContract({ ...req, chosen: true }, parseResponse(JSON.stringify(declined)))
  assert.ok(problems.some(p => p.includes('chose')), problems.join('; '))
  assert.ok(problems.some(p => p.includes('below the seniority floor')), 'the model\'s own reason, so the log says why')
})

test('a bulk skip is still a valid answer — the triage queue depends on it', () => {
  assert.deepEqual(checkContract(req, parseResponse(JSON.stringify(declined))), [])
})

test('the procedure keeps no hard skip for a post the owner chose', () => {
  const proc = readProcedure()
  const from = proc.indexOf('### When `chosen` is true')
  const to = proc.indexOf('### Soft flags')
  // anchored first: an unchecked indexOf of -1 would slice nothing and pass the assertions below vacuously
  assert.ok(from >= 0 && to > from, 'the chosen section and the section after it must both still exist')
  const chosen = proc.slice(from, to)
  assert.doesNotMatch(chosen, /stays? (?:a )?hard skips?/i)
  assert.match(chosen, /Nothing is a skip/)
})

test('profileBlock carries the identity the skill deliberately does not hardcode', () => {
  const b = profileBlock(config)
  assert.ok(b.includes(config.profile.name))
  assert.ok(b.includes(config.profile.email))
  assert.ok(b.includes(config.profile.phone))
  assert.ok(b.includes('Saudi Arabia'))
  assert.match(b, /Can start immediately: yes/)
})

test('profileBlock states a notice period honestly when the switch is off', () => {
  const c = { ...config, constraints: { ...config.constraints, canStartImmediately: false } }
  assert.match(profileBlock(c), /Can start immediately: no — there is a notice period/)
})

// The honesty rails are generic procedure, so they can be asserted literally. They used to be
// asserted through buildSystemPrompt against one person's gaps read off disk, in a test whose own
// comment said it had to run on a clone.
test('the procedure keeps the honesty rails that make this safe to point at real recruiters', () => {
  const proc = readProcedure()
  assert.ok(proc.includes('never claim experience the candidate does not have'))
  assert.ok(proc.includes('that is a gap, not an inference'))
  assert.ok(proc.includes('never quote it'))
  assert.ok(proc.includes('Declare every gap the posting'))
  assert.ok(proc.includes('Use no name but the injected one'))
})

test('the composed prompt carries THIS config\'s evidence, gaps and strengths', () => {
  const cfg = {
    ...config,
    scope: { ...config.scope, roleFamily: 'structural engineering', seniorityFloor: 6 },
    background: {
      strengths: ['STRENGTHS-MARKER'], evidence: 'EVIDENCE-MARKER',
      gaps: ['GAPS-MARKER'], neverClaim: ['NEVERCLAIM-MARKER']
    }
  }
  const p = buildSystemPrompt(cfg)
  for (const marker of ['EVIDENCE-MARKER', 'GAPS-MARKER', 'STRENGTHS-MARKER', 'NEVERCLAIM-MARKER']) {
    assert.ok(p.includes(marker), `${marker} never reached the prompt`)
    assert.ok(p.indexOf(marker) < p.indexOf(PROMPT_SEPARATOR), `${marker} must sit ABOVE the separator`)
  }
  assert.ok(p.includes('Field of work: structural engineering'))
  assert.match(p, /asking for 6 years or fewer is below/)
})

test('every person-specific byte of the prompt comes from the settings', () => {
  // The property, stated directly: swap the settings and ALL person content swaps with them. This is
  // what SKILL.md could not satisfy — it hardcoded a name into the subject-line template, so every
  // install emailed recruiters under the wrong name however Settings was filled in.
  const a = { ...config, profile: { ...config.profile, name: 'Ada Lovelace' },
    background: { ...config.background, evidence: 'Wrote the first algorithm.' } }
  const b = { ...config, profile: { ...config.profile, name: 'Grace Hopper' },
    background: { ...config.background, evidence: 'Built the first compiler.' } }
  const pa = buildSystemPrompt(a)
  const pb = buildSystemPrompt(b)
  const proc = readProcedure()
  assert.ok(pa.endsWith(proc), 'the procedure must be appended byte for byte')
  assert.ok(pb.endsWith(proc))
  // never split the composed prompt on '---': a user's evidence may legitimately contain one
  assert.equal(pa.slice(pa.length - proc.length), pb.slice(pb.length - proc.length))
  assert.ok(!pa.includes('Grace Hopper'), 'one candidate\'s prompt must not carry another\'s identity')
  assert.ok(!pb.includes('Ada Lovelace'))
  assert.ok(!pa.includes('Built the first compiler.'))
})

test('an empty config still composes a usable prompt rather than a confident blank', () => {
  const p = buildSystemPrompt(emptySettings())
  assert.ok(p.includes('(none provided'), 'an unfilled section must say so, not stand empty')
  assert.ok(!p.includes('undefined'))
  // no rule may be emitted with a blank where its setting should be
  assert.ok(!/Field of work:\s*$/m.test(p))
  assert.ok(!/Primary skills:\s*$/m.test(p))
})

test('candidateBlock and the procedure are the two halves, and only the first one varies', () => {
  assert.ok(buildSystemPrompt(config).startsWith(candidateBlock(config)))
})

// ---------------- the placeholder guard ----------------
//
// A real recruiter received an application whose salary line read "[ADD BEFORE SENDING]" and replied to
// point it out. The drafter has no tools and nothing reviews its output, so a body with a hole in it is
// delivered verbatim unless something refuses it. These four pin both directions: an incomplete email
// must be rejected, and an ordinary one must still pass, or the guard would quietly empty the queue.

test('checkContract rejects a body that still carries an unfilled placeholder', () => {
  const holed = {
    results: [{ ...ok.results[0], body: 'Hello. Expected monthly salary: [ADD BEFORE SENDING]. CV attached.' }, ok.results[1]],
    report: ''
  }
  const problems = checkContract(req, parseResponse(JSON.stringify(holed)))
  assert.ok(problems.some(p => p.includes('placeholder')), problems.join('; '))
})

test('checkContract rejects a placeholder left in the subject', () => {
  const holed = { results: [{ ...ok.results[0], subject: 'Application - [POSITION]' }, ok.results[1]], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(holed)))
  assert.ok(problems.some(p => p.includes('placeholder')), problems.join('; '))
})

test('checkContract rejects a TBD standing in for a value', () => {
  const holed = { results: [{ ...ok.results[0], body: 'Expected salary: TBD, happy to discuss.' }, ok.results[1]], report: '' }
  const problems = checkContract(req, parseResponse(JSON.stringify(holed)))
  assert.ok(problems.some(p => p.includes('placeholder')), problems.join('; '))
})

test('checkContract passes a complete email that states a real figure', () => {
  const filled = {
    results: [{ ...ok.results[0], body: 'Hello. Expected monthly salary: 8,000 USD. CV attached.' }, ok.results[1]],
    report: ''
  }
  assert.deepEqual(checkContract(req, parseResponse(JSON.stringify(filled))), [])
})

// A master CV bullet id is written "(r0.b3)" in the prompt so PLACEHOLDER's square-bracket half cannot
// reject the email over it. Inside the CV a copied id fails rule 5, because masterText carries values and
// never ids; the email half was prompt-only, and this repo has already delivered one prompt-only rule.

test('checkContract rejects a master-CV bullet id copied into the email', () => {
  const leaked = {
    results: [{ ...ok.results[0], body: 'I led that migration (r0.b3) end to end. CV attached.' }, ok.results[1]],
    report: ''
  }
  const problems = checkContract(req, parseResponse(JSON.stringify(leaked)))
  assert.ok(problems.some(p => p.includes('r0.b3')), problems.join('; '))
})

test('checkContract leaves an ordinary email alone: a bare role id shape is not an id', () => {
  // The other direction, and the reason only the dotted form is matched: a guard that also rejected "R2"
  // or "S1" would fail the same post every run, because a contract failure writes no row.
  const plain = {
    results: [{ ...ok.results[0], body: 'I shipped the R2 release and ran the S1 rollout. CV attached.' }, ok.results[1]],
    report: ''
  }
  assert.deepEqual(checkContract(req, parseResponse(JSON.stringify(plain))), [])
})

test('profileBlock quotes the expected salary, and says so plainly when there is none', () => {
  const withSalary = { ...config, constraints: { ...config.constraints, expectedSalary: '8,000 USD / month' } }
  assert.match(profileBlock(withSalary), /quote verbatim when a post asks for one: 8,000 USD/)
  // Empty must not read as a blank value: the model has to know it is missing so it skips the post.
  assert.match(profileBlock({ ...config, constraints: { ...config.constraints, expectedSalary: '' } }), /NOT PROVIDED/)
})

const cvContent = {
  summary: 'Backend engineer with 9 years on .NET.',
  roles: [{ title: 'Engineering Manager', employer: 'Example Corp', location: 'Remote', start: '2021', end: 'Present', bullets: ['Led a team of 12 engineers.'] }],
  skills: [{ group: 'Backend', items: ['C#', '.NET'] }],
  education: [],
  certifications: [],
  achievements: [],
  personalDetails: [],
  interests: [],
  languages: []
}

test('a malformed cv block never fails the email it arrived with', () => {
  const parsed = parseResponse(JSON.stringify({ ...ok, cv: { roles: 'not an array' } }))
  assert.equal(parsed.results.length, ok.results.length)
  assert.deepEqual(parsed.cv, { roles: 'not an array' })
})

test('the master CV is injected above the separator, and the procedure still follows byte for byte', () => {
  const p = buildSystemPrompt(config, assignIds(cvContent))
  assert.ok(p.includes('(r0.b0) Led a team of 12 engineers.'))
  assert.ok(p.indexOf(MASTER_CV_HEADING) < p.indexOf(PROMPT_SEPARATOR), 'the master CV must sit ABOVE the separator')
  assert.ok(p.endsWith(readProcedure()))
  assert.equal(buildSystemPrompt(config).includes(MASTER_CV_HEADING), false, 'no master CV means no block')
})

test('a master CV that would push the prompt past PROMPT_BUDGET does not fit', () => {
  assert.equal(fitsPromptBudget(config, assignIds(cvContent)), true)
  assert.equal(fitsPromptBudget(config, assignIds({ ...cvContent, summary: 'x'.repeat(PROMPT_BUDGET) })), false)
})

// ---------------- follow-up: the role the application named ----------------

const fu: DraftRequest = {
  mode: 'follow-up',
  recruiterEmail: 'hr@acme.sa',
  originalSentAt: '2026-09-20',
  posts: [
    { ...req.posts[0]!, named: true },
    { ...req.posts[1]!, named: false }
  ]
}

test('a follow-up about the applied role, plus a skipped newer post, is a valid answer', () => {
  const res = parseResponse(JSON.stringify({ results: [
    { key: 'a'.repeat(40), verdict: 'drafted', reason: 'named in follow-up; still interested', body: 'B' },
    { key: 'b'.repeat(40), verdict: 'skipped', reason: 'on-site outside the injected scope' }
  ] }))
  assert.deepEqual(checkContract(fu, res), [])
})

test('checkContract refuses a skip on the role the application already named', () => {
  // A skipped subject is a follow-up that is never written — the 2026-09-25 failure, reached another way.
  const res = parseResponse(JSON.stringify({ results: [
    { key: 'a'.repeat(40), verdict: 'skipped', reason: 'location outside scope' },
    { key: 'b'.repeat(40), verdict: 'drafted', reason: 'named in follow-up; newer role', body: 'B' }
  ] }))
  assert.ok(checkContract(fu, res).some(p => p.includes('already named')))
})

test('checkContract refuses a follow-up about an applied role that carries no body', () => {
  const res = parseResponse(JSON.stringify({ results: [
    { key: 'a'.repeat(40), verdict: 'drafted', reason: 'named in follow-up; still interested' },
    { key: 'b'.repeat(40), verdict: 'skipped', reason: 'not a fit' }
  ] }))
  assert.ok(checkContract(fu, res).some(p => p.includes('no email body')))
})

test('with no named role, an all-skipped follow-up is still allowed to say nothing', () => {
  // control: the no-body rule is about a follow-up that has a subject, not a blanket requirement
  const none = { ...fu, posts: fu.posts.map(p => ({ ...p, named: false })) }
  const res = parseResponse(JSON.stringify({ results: none.posts.map(p => ({ key: p.key, verdict: 'skipped', reason: 'not a fit' })) }))
  assert.deepEqual(checkContract(none, res), [])
})

test('the procedure tells the follow-up what already_named and original_sent_at mean', () => {
  const proc = readProcedure()
  assert.match(proc, /already_named/)
  assert.match(proc, /original_sent_at/)
  assert.match(proc, /Never skip one/)
})

// ---------------- the drafter's environment ----------------

test('userSettingsEnv passes on the user settings env block and nothing else', async () => {
  // --setting-sources local skips ~/.claude/settings.json whole; its env (certificates, auth, routing)
  // has to reach the drafter anyway, or drafts fail on a machine that needs it.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { userSettingsEnv } = await import('../server/utils/drafter.ts')
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-env-'))
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: '/x/ca.pem', NUM: 3 }, hooks: { SessionStart: [] }, model: 'opus' }))
    assert.deepEqual(userSettingsEnv(file), { NODE_EXTRA_CA_CERTS: '/x/ca.pem' }, 'string values only; hooks and model stay out')
    assert.deepEqual(userSettingsEnv(join(dir, 'missing.json')), {}, 'no settings file is an empty env, not a crash')
    writeFileSync(file, '{not json')
    assert.deepEqual(userSettingsEnv(file), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a real-sized prompt with a master CV fits the budget, with room to grow', () => {
  // The owner's real prompt measured 28,165 on 2026-09-26; this fixture plus a CV of that size must fit
  // with room, so a procedure edit can never again switch tailoring off by a few hundred characters.
  const big = assignIds({ ...cvContent, summary: 'y'.repeat(30_000) })
  assert.equal(fitsPromptBudget(config, big), true)
})
