// The Posts view's country filter reads the scoring model's free-text `location`. homeCountryOf() only
// resolves a whole comma segment, which measured 2026-10-01 covered half the located posts; these pin
// the broader resolver the filter uses, and the city table that must stay filter-only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countriesIn, locationMatches, NO_COUNTRY, resolveCountry } from '../shared/countries.ts'

const name = (s: string) => resolveCountry(s)!.name

test('countriesIn: comma form, word inside prose, US state, bare city, multi-country, nothing', () => {
  assert.deepEqual(countriesIn('Cairo, Egypt'), [name('Egypt')])
  assert.deepEqual(countriesIn('Egypt (onsite 1 day / remote 4 days)'), [name('Egypt')])
  assert.deepEqual(countriesIn('Hybrid - Vietnam (Q2 Hybrid)'), [name('Vietnam')])
  assert.deepEqual(countriesIn('Charlotte, NC'), [name('USA')])
  assert.deepEqual(countriesIn('Houston, TX or Dallas, TX (Onsite)'), [name('USA')])
  assert.deepEqual(countriesIn('Bangalore'), [name('India')])
  assert.deepEqual(countriesIn('Pune / Bangalore'), [name('India')])
  assert.deepEqual(countriesIn('Dubai'), [name('UAE')])
  assert.deepEqual(countriesIn('Remote (Bulgaria / Romania / Poland)').sort(), [name('Bulgaria'), name('Poland'), name('Romania')].sort())
  assert.deepEqual(countriesIn('Hybrid (non-negotiable)'), [])
  assert.deepEqual(countriesIn('unknown'), [])
  assert.deepEqual(countriesIn(null), [])
})

test('countriesIn: a name inside a longer word is not a match', () => {
  // "Oman" sits inside "Romania" (r-OMAN-ia); a substring match would report both
  assert.ok(!countriesIn('Remote (Romania)').includes(name('Oman')))
})

test('every city in the filter table resolves to a real country', () => {
  for (const city of ['Bangalore', 'Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Mumbai', 'Noida', 'Gurugram',
    'Indore', 'Dubai', 'Abu Dhabi', 'Riyadh', 'Jeddah', 'Dammam', 'Cairo', 'Doha', 'Lahore', 'Amman']) {
    assert.equal(countriesIn(city).length, 1, city)
  }
})

test('locationMatches: a picked country, and NO_COUNTRY for what resolves to nothing', () => {
  assert.equal(locationMatches('Pune', [name('India')]), true)
  assert.equal(locationMatches('Pune', [name('Egypt')]), false)
  assert.equal(locationMatches(null, [NO_COUNTRY]), true)
  assert.equal(locationMatches('Remote', [NO_COUNTRY]), true)
  assert.equal(locationMatches('Pune', [NO_COUNTRY]), false)
})

// Measured misses, 2026-10-03 (docs/superpowers/specs/2026-10-03-location-indicator-design.md).
test('countriesIn: US states spelled out, Georgia the state vs the country, provinces, more cities, Arabic', () => {
  assert.deepEqual(countriesIn('Atlanta, Georgia'), ['USA'], 'the US state, not the country')
  assert.deepEqual(countriesIn('Atlanta, Georgia, USA'), ['USA'])
  assert.deepEqual(countriesIn('Tbilisi, Georgia'), ['Georgia'])
  assert.deepEqual(countriesIn('Austin, Texas'), ['USA'])
  assert.deepEqual(countriesIn('Des Moines, Iowa'), ['USA'])
  assert.deepEqual(countriesIn('Toronto, ON'), ['Canada'])
  assert.deepEqual(countriesIn('Jaipur'), ['India'])
  assert.deepEqual(countriesIn('Vadodara, Gujarat'), ['India'])
  assert.deepEqual(countriesIn('Coimbatore'), ['India'])
  assert.deepEqual(countriesIn('Ikeja, Lagos'), ['Nigeria'])
  assert.deepEqual(countriesIn('المنطقة الشرقية، المملكة العربية السعودية'), ['Saudi Arabia'])
  assert.deepEqual(countriesIn('القاهرة، مصر'), ['Egypt'])
})

test('the display-only tables never reach a prompt', async () => {
  const { withAliases, nameFormsFor } = await import('../shared/countries.ts')
  assert.equal(withAliases(['Saudi Arabia']), 'Saudi Arabia (KSA, Kingdom of Saudi Arabia)')
  assert.equal(nameFormsFor(['India']).some(f => /jaipur|bengaluru/i.test(f)), false)
})
