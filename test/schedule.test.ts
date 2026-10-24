// The scheduled scrape's clock: which slot is due, when the next one is, and what the run is given.
// Dates are built with the local-time constructor because the schedule is on the machine's own clock.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDue, lastSlot, nextSlot, scheduledArgs, tick, TICK_MS } from '../shared/schedule.ts'
import { emptySettings } from '../shared/settings.ts'

// 2026-10-11 is a Sunday
const at = (day: number, hour: number, min = 0) => new Date(2026, 9, day, hour, min)

test('off has no slots and is never due', () => {
  assert.equal(lastSlot('off', at(11, 12)), null)
  assert.equal(nextSlot('off', at(11, 12)), null)
  assert.equal(isDue('off', at(1, 0), at(11, 12)), false)
})

test('daily: 09:00 every day', () => {
  assert.deepEqual(lastSlot('daily', at(11, 8, 59)), at(10, 9))
  assert.deepEqual(lastSlot('daily', at(11, 9)), at(11, 9), 'a slot is due at its own minute')
  assert.deepEqual(nextSlot('daily', at(11, 9)), at(12, 9), 'the next slot is strictly after now')
})

test('twice daily: 09:00 and 21:00', () => {
  assert.deepEqual(lastSlot('twice-daily', at(11, 20)), at(11, 9))
  assert.deepEqual(lastSlot('twice-daily', at(11, 21, 30)), at(11, 21))
  assert.deepEqual(lastSlot('twice-daily', at(11, 3)), at(10, 21))
  assert.deepEqual(nextSlot('twice-daily', at(11, 10)), at(11, 21))
})

test('weekly: Sunday 09:00', () => {
  assert.deepEqual(lastSlot('weekly', at(17, 12)), at(11, 9))
  assert.deepEqual(lastSlot('weekly', at(11, 8)), at(4, 9), 'before Sunday\'s slot, it is last week\'s')
  assert.deepEqual(nextSlot('weekly', at(11, 10)), at(18, 9))
})

test('twice weekly: Sunday and Wednesday 09:00', () => {
  assert.deepEqual(lastSlot('twice-weekly', at(13, 12)), at(11, 9))
  assert.deepEqual(lastSlot('twice-weekly', at(15, 12)), at(14, 9))
  assert.deepEqual(nextSlot('twice-weekly', at(15, 12)), at(18, 9))
})

test('due once per missed slot, however many were missed, and never before a first baseline', () => {
  assert.equal(isDue('daily', at(10, 9, 5), at(11, 9, 10)), true, 'yesterday\'s run, today\'s slot')
  assert.equal(isDue('daily', at(11, 9, 5), at(11, 9, 10)), false, 'today\'s slot already ran')
  assert.equal(isDue('daily', at(1, 9), at(11, 15)), true, 'the PC was off for days: one run, now')
  assert.equal(isDue('daily', at(11, 15), at(11, 15, 10)), false, 'and not again after it is recorded')
  assert.equal(isDue('daily', null, at(11, 15)), false, 'no baseline yet: switching it on does not fire at once')
})

test('a tick writes only when something changes — an idle tick would push a hand-off snapshot', () => {
  assert.deepEqual(tick('off', null, at(11, 9), TICK_MS), { run: false }, 'off and nothing recorded: no write')
  assert.deepEqual(tick('off', at(10, 9), at(11, 9), TICK_MS), { run: false, save: null }, 'switched off: forget the last run')
  assert.deepEqual(tick('daily', at(11, 9, 5), at(11, 12), TICK_MS), { run: false }, 'not due: no write')
  assert.deepEqual(tick('daily', at(10, 9, 5), at(11, 9, 10), TICK_MS), { run: true, save: at(11, 9, 10) }, 'due: run, spend the slot')
})

test('switching on records a baseline one tick back, so a slot inside that gap still runs', () => {
  // saved at 08:55, first tick at 09:00:30 — the card said "Next: 09:00"
  const first = tick('daily', null, new Date(2026, 9, 11, 9, 0, 30), TICK_MS)
  assert.deepEqual(first, { run: false, save: new Date(2026, 9, 11, 8, 50, 30) })
  assert.equal(tick('daily', first.save!, at(11, 9, 10), TICK_MS).run, true)
  // saved at 09:05, after the slot — the first tick at 09:10 must not run it
  const late = tick('daily', null, at(11, 9, 10), TICK_MS)
  assert.equal(tick('daily', late.save!, at(11, 9, 20), TICK_MS).run, false)
})

test('same as manual: the main terms with their rotation, and a date window matching the frequency', () => {
  const cfg = { ...emptySettings(), terms: ['a', 'b'], max: 30 }
  assert.deepEqual(scheduledArgs({ ...cfg, schedule: { ...cfg.schedule, every: 'daily' } }), { since: 'past-24h' })
  assert.deepEqual(scheduledArgs({ ...cfg, schedule: { ...cfg.schedule, every: 'twice-daily' } }), { since: 'past-24h' })
  // a weekly run with the manual past-24h window would never see six days of posts
  assert.deepEqual(scheduledArgs({ ...cfg, schedule: { ...cfg.schedule, every: 'weekly' } }), { since: 'past-week' })
  assert.deepEqual(scheduledArgs({ ...cfg, schedule: { ...cfg.schedule, every: 'twice-weekly' } }), { since: 'past-week' })
})

test('its own settings: its terms, cards and window — and the main terms when it names none', () => {
  const cfg = emptySettings()
  const own = { ...cfg.schedule, every: 'weekly' as const, own: true, terms: ['x y', 'feed'], max: 20, since: 'past-month' as const }
  assert.deepEqual(scheduledArgs({ ...cfg, schedule: own }), { terms: 'x y,feed', max: 20, since: 'past-month' })
  assert.deepEqual(scheduledArgs({ ...cfg, schedule: { ...own, terms: [] } }), { max: 20, since: 'past-month' })
})
