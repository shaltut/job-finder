import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_GAPS, backgroundInstructions, gapsFrom, type RequirementRow } from '../shared/background.ts'

const TITLES = ['Senior Structural Engineer', 'Bridge Design Engineer']

const row = (over: Partial<RequirementRow> = {}): RequirementRow => ({
  requirement: 'seismic retrofit experience',
  askedForBy: 'Senior Structural Engineer',
  status: 'absent',
  cvShows: '',
  sentence: 'The CV shows no seismic retrofit work; it shows nine years of new-build bridge design.',
  ...over
})

test('a valid absent row becomes a gap, and a present row simply is not one', () => {
  const { gaps, dropped } = gapsFrom([row(), row({ status: 'present', cvShows: 'ETABS, SAP2000' })], TITLES)
  assert.equal(gaps.length, 1)
  assert.match(gaps[0]!, /no seismic retrofit work/)
  // 'present' is not a rejection worth reporting — it is the common case
  assert.deepEqual(dropped, [])
})

test('a partial row needs the CV words that settle it', () => {
  const ok = gapsFrom([row({ status: 'partial', cvShows: 'AutoCAD 2D drafting, 2014-2017' })], TITLES)
  assert.equal(ok.gaps.length, 1)
  const bad = gapsFrom([row({ status: 'partial', cvShows: '' })], TITLES)
  assert.equal(bad.gaps.length, 0)
  assert.match(bad.dropped[0]!.why, /nothing quoted from the CV/)
})

test('a gap attributed to a title you do not target is discarded — this is the invention guard', () => {
  // To invent a gap the model must also invent a requirement AND pin it to a title this person
  // actually searches. That attribution is checked here, not asked for in prose.
  const { gaps, dropped } = gapsFrom([row({ askedForBy: 'Machine Learning Engineer' })], TITLES)
  assert.deepEqual(gaps, [])
  assert.match(dropped[0]!.why, /title you do not target/)
})

test('attribution matching ignores case and surrounding whitespace', () => {
  assert.equal(gapsFrom([row({ askedForBy: '  senior structural ENGINEER ' })], TITLES).gaps.length, 1)
})

test('a quoted first-person sentence is discarded: that wording must come from the person', () => {
  // The drafter is told to reuse such a sentence VERBATIM in a real email, so a model-authored one
  // would put words the candidate never wrote into their own voice.
  const { gaps, dropped } = gapsFrom([row({ sentence: '"I have never worked on seismic retrofits."' })], TITLES)
  assert.deepEqual(gaps, [])
  assert.match(dropped[0]!.why, /must come from you/)
  assert.equal(gapsFrom([row({ sentence: '“Smart quotes too.”' })], TITLES).gaps.length, 0)
})

test('an absent row that quotes the CV contradicts itself and is discarded', () => {
  const { gaps, dropped } = gapsFrom([row({ status: 'absent', cvShows: 'some seismic work' })], TITLES)
  assert.deepEqual(gaps, [])
  assert.match(dropped[0]!.why, /marked absent but quotes the CV/)
})

test('an empty sentence is discarded', () => {
  assert.equal(gapsFrom([row({ sentence: '   ' })], TITLES).gaps.length, 0)
})

test('duplicates collapse and the list is capped', () => {
  assert.equal(gapsFrom([row(), row(), row()], TITLES).gaps.length, 1)
  const many = Array.from({ length: MAX_GAPS + 5 }, (_, i) => row({ sentence: `Gap number ${i}.` }))
  const { gaps, dropped } = gapsFrom(many, TITLES)
  assert.equal(gaps.length, MAX_GAPS)
  assert.equal(dropped.filter(d => d.why.includes('more than')).length, 5)
})

test('gapsFrom survives a model that returns nothing usable at all', () => {
  assert.deepEqual(gapsFrom([], TITLES).gaps, [])
  assert.deepEqual(gapsFrom(undefined as unknown as RequirementRow[], TITLES).gaps, [])
  assert.deepEqual(gapsFrom([row()], []).gaps, [], 'no titles means no closed universe, so nothing survives')
})

test('the instructions name every target title, and never a profession when none is set', () => {
  const withField = backgroundInstructions(TITLES, 'structural engineering')
  for (const t of TITLES) assert.ok(withField.includes(t))
  assert.ok(withField.includes('They describe their field as: structural engineering'))
  assert.ok(withField.includes('it may be from any profession'))

  const without = backgroundInstructions(TITLES, '')
  assert.ok(without.includes('do not widen it'))
  assert.ok(!without.includes('field as:'), 'an unset field must not become a blank claim')
})
