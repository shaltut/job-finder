import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildSystemPrompt, checkContract, parseResponse, profileBlock, type DraftRequest } from '../server/utils/drafter.ts'
import type { AppConfig } from '../server/utils/config.ts'

const config = JSON.parse(readFileSync('config.json', 'utf8')) as AppConfig

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
  assert.match(profileBlock(c), /Can start immediately: no — he has a notice period/)
})

test('the system prompt contains both the injected identity and the skill body', () => {
  const p = buildSystemPrompt(config)
  assert.ok(p.includes(config.profile.name))
  assert.ok(p.includes('never claim experience the candidate does not have'))
  // the honesty rails that make this tool safe to point at real recruiters
  assert.ok(p.includes('Never quote the percentage figures'))
  assert.ok(p.includes('has never held a Lead, Manager or Head title'))
  assert.ok(p.includes('No cloud, database, DevOps or CI/CD'))
})
