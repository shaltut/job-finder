// The Posts view's state as a pure value (shared/posts-view.ts): the URL round trip, the chips, the
// header sort cycle and shift-click ranges. There is no Vue test setup here, so this is where the page's
// logic is pinned — the same arrangement as shared/paste-poll.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SORTS as SERVER_SORTS } from '../server/utils/posts-query.ts'
import { activeChips, apiQuery, DEFAULT_VIEW, nextSort, parseView, rangeKeys, SORTS, viewQuery } from '../shared/posts-view.ts'

test('the client sort list matches the server allowlist', () => {
  assert.deepEqual([...SORTS], [...SERVER_SORTS])
})

test('a bare URL is the default view, and the default view writes an empty query', () => {
  assert.deepEqual(parseView({}), DEFAULT_VIEW)
  assert.deepEqual(viewQuery(DEFAULT_VIEW), {})
})

test('junk in the URL falls back per key, never throws', () => {
  const v = parseView({ sort: 'foo', dir: 'up', page: '-3', minScore: '7', status: 'nope', posted: 'x', country: '', q: '  rust  ' })
  assert.equal(v.sort, 'default')
  assert.equal(v.dir, 'desc')
  assert.equal(v.page, 1)
  assert.equal(v.minScore, 0) // only 0 / 6 / 8 are offered
  assert.equal(v.status, 'unprocessed')
  assert.equal(v.posted, 0)
  assert.deepEqual(v.country, [])
  assert.equal(v.q, 'rust')
})

test('round trip: every non-default value survives URL → view → URL', () => {
  const v = { ...DEFAULT_VIEW, status: 'drafted' as const, minScore: 6, posted: 7, country: ['India', 'Egypt'], countryMode: 'include' as const, sort: 'posted' as const, dir: 'asc' as const, page: 3 }
  assert.deepEqual(parseView(viewQuery(v)), v)
})

test('a single country in the URL arrives as a string, not an array', () => {
  assert.deepEqual(parseView({ country: 'India' }).country, ['India'])
})

test('apiQuery carries paging and every filter the API reads', () => {
  const q = apiQuery({ ...DEFAULT_VIEW, page: 2 }, 100)
  assert.equal(q.offset, 100)
  assert.equal(q.limit, 100)
  assert.equal(q.status, 'unprocessed')
  assert.equal('page' in q, false)
})

test('chips list only what differs from the default', () => {
  assert.deepEqual(activeChips(DEFAULT_VIEW), [])
  const chips = activeChips({ ...DEFAULT_VIEW, minScore: 6, country: ['India'], countryMode: 'exclude' })
  assert.deepEqual(chips.map(c => c.key), ['minScore', 'country'])
  assert.match(chips[1]!.label, /not India/)
})

test('sort cycles desc → asc → default, and a new column starts at desc', () => {
  let s = nextSort({ sort: 'default', dir: 'desc' }, 'posted')
  assert.deepEqual(s, { sort: 'posted', dir: 'desc' })
  s = nextSort(s, 'posted')
  assert.deepEqual(s, { sort: 'posted', dir: 'asc' })
  s = nextSort(s, 'posted')
  assert.deepEqual(s, { sort: 'default', dir: 'desc' })
  assert.deepEqual(nextSort({ sort: 'score', dir: 'asc' }, 'added'), { sort: 'added', dir: 'desc' })
})

test('rangeKeys: the inclusive span either direction; a missing anchor is a single toggle', () => {
  const keys = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(rangeKeys(keys, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeKeys(keys, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(rangeKeys(keys, 'gone', 'c'), ['c']) // anchor left the page
  assert.deepEqual(rangeKeys(keys, null, 'c'), ['c'])
})
