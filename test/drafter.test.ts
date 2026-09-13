import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PROMPT_SEPARATOR, buildSystemPrompt, candidateBlock, checkContract, parseResponse,
  profileBlock, readProcedure, type DraftRequest
} from '../server/utils/drafter.ts'
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
