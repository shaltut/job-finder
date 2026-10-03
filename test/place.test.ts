// The Posts view's Location cell. Cases are the measured shapes of posts.location, 2026-10-03.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { flagOf, placeOf } from '../shared/place.ts'

const names = (p: ReturnType<typeof placeOf>) => p.countries.map(c => c.name)

test('a city and its country, one spelling', () => {
  const p = placeOf('Riyadh, Saudi Arabia', '', false)
  assert.deepEqual(names(p), ['Saudi Arabia'])
  assert.equal(p.countries[0]!.flag, flagOf('SA'))
  assert.equal(p.city, 'Riyadh')
  assert.equal(p.mode, null)
  assert.equal(p.stated, true)
  assert.equal(placeOf('Bangalore', '', false).city, 'Bengaluru')
  assert.equal(placeOf('Bengaluru, India', '', false).city, 'Bengaluru')
  assert.equal(placeOf('Saudi Arabia', '', false).city, null, 'a country alone has no city')
})

test('remote tied to a country, and remote anywhere', () => {
  const r = placeOf('Remote (India)', '', true)
  assert.deepEqual(names(r), ['India'])
  assert.equal(r.mode, 'remote')
  assert.equal(r.city, null)
  const any = placeOf('remote', '', true)
  assert.deepEqual(any.countries, [])
  assert.equal(any.mode, 'remote')
  assert.equal(any.stated, true)
})

test('the remote flag fills in what the location text leaves out', () => {
  const p = placeOf('Cairo, Egypt', '', true)
  assert.equal(p.mode, 'remote')
  assert.equal(p.modeFromText, false)
})

test('the body supplies hybrid / on-site only, and the location always wins', () => {
  const u = placeOf('unknown', 'We work hybrid, 3 days in the office', false)
  assert.equal(u.stated, false)
  assert.equal(u.mode, 'hybrid')
  assert.equal(u.modeFromText, true)
  assert.equal(placeOf('Dubai', 'This is an on-site role', false).mode, 'onsite')
  assert.equal(placeOf('Dubai', 'our remote team is great', false).mode, null, 'a bare "remote" in a body is noise')
  const w = placeOf('Remote', 'hybrid allowed', true)
  assert.equal(w.mode, 'remote')
  assert.equal(w.modeFromText, false)
  assert.equal(placeOf('Manchester, hybrid', '', false).mode, 'hybrid')
  assert.equal(placeOf('Clevedon, hybrid (3 days onsite)', '', false).mode, 'hybrid', 'first mentioned wins')
})

test('regions, several countries, nothing at all', () => {
  const r = placeOf('Middle East', '', false)
  assert.deepEqual(r.countries, [])
  assert.equal(r.region, 'Middle East')
  assert.deepEqual(names(placeOf('UAE & KSA', '', false)).sort(), ['Saudi Arabia', 'UAE'])
  for (const empty of [null, '', 'unknown', 'Not specified']) {
    const p = placeOf(empty, '', false)
    assert.equal(p.stated, false, String(empty))
    assert.deepEqual(p.countries, [])
    assert.equal(p.city, null)
  }
})
