// The scheduled scrape's clock. Pure, like shared/settings.ts: the server task decides with it, the
// Settings page shows the next run with it, and test/schedule.test.ts exercises it.
//
// Slots are fixed times on the machine's own clock. A tick that finds the latest slot newer than the
// last scheduled run starts one scrape — so a PC that was off at 09:00 scrapes once when the server is
// back, not once per slot it missed.
import type { StoredSettings } from './settings.ts'

export const FREQUENCIES = ['off', 'weekly', 'twice-weekly', 'daily', 'twice-daily'] as const
export type Frequency = (typeof FREQUENCIES)[number]

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  'off': 'Off',
  'weekly': 'Once a week — Sunday 09:00',
  'twice-weekly': 'Twice a week — Sunday and Wednesday 09:00',
  'daily': 'Once a day — 09:00',
  'twice-daily': 'Twice a day — 09:00 and 21:00'
}

// ponytail: fixed hours and weekdays; an hour picker when someone wants a different time
const PLAN: Record<Exclude<Frequency, 'off'>, { days: number[], hours: number[] }> = {
  'weekly': { days: [0], hours: [9] },
  'twice-weekly': { days: [0, 3], hours: [9] },
  'daily': { days: [0, 1, 2, 3, 4, 5, 6], hours: [9] },
  'twice-daily': { days: [0, 1, 2, 3, 4, 5, 6], hours: [9, 21] }
}

/** Each slot on the day `offset` days from `now`'s, in time order. */
const slotsOn = (every: Exclude<Frequency, 'off'>, now: Date, offset: number): Date[] => {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const { days, hours } = PLAN[every]
  return days.includes(day.getDay()) ? hours.map(h => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h)) : []
}

/** The latest slot at or before `now`; null when the schedule is off. */
export function lastSlot(every: Frequency, now: Date): Date | null {
  if (every === 'off') return null
  for (let back = 0; back <= 7; back++) {
    const hit = slotsOn(every, now, -back).filter(s => s <= now).at(-1)
    if (hit) return hit
  }
  return null
}

/** The first slot strictly after `now`; null when the schedule is off. */
export function nextSlot(every: Frequency, now: Date): Date | null {
  if (every === 'off') return null
  for (let ahead = 0; ahead <= 7; ahead++) {
    const hit = slotsOn(every, now, ahead).find(s => s > now)
    if (hit) return hit
  }
  return null
}

/**
 * Whether a scheduled scrape should start now. With no recorded run there is nothing to compare
 * against, and tick() records a baseline instead: switching the schedule on must not fire a scrape on
 * the spot, maybe minutes after a manual one.
 */
export function isDue(every: Frequency, lastRunAt: Date | null, now: Date): boolean {
  const slot = lastSlot(every, now)
  return !!slot && !!lastRunAt && lastRunAt < slot
}

/** The server task's tick, in nuxt.config.ts: every ten minutes. */
export const TICK_MS = 10 * 60_000

/**
 * What one tick does: whether to start a scheduled scrape, and what to record as the last run —
 * `save` absent means write nothing. Writes happen only when something changes: every write moves
 * data_version and the hand-off pushes a snapshot for it, so an idle tick must not write (the inbox
 * poll's lesson).
 *
 * - Off: forget the last run, so switching back on waits for the next slot instead of firing at once.
 * - First tick after switching on: a baseline backdated one tick, because the switch happened at most
 *   that long ago — a slot inside the gap still runs, as the Settings card's "Next" promised.
 * - Due: run, and spend the slot now — whether the scrape then runs, is skipped or fails. Retrying a
 *   throttled (exit 3) scrape ten minutes later is exactly wrong.
 */
export function tick(every: Frequency, last: Date | null, now: Date, tickMs: number): { run: boolean, save?: Date | null } {
  if (every === 'off') return last ? { run: false, save: null } : { run: false }
  if (!last) return { run: false, save: new Date(now.getTime() - tickMs) }
  return isDue(every, last, now) ? { run: true, save: now } : { run: false }
}

type Since = StoredSettings['since']

/**
 * What the scheduled scrape is given, as the scrape job's args.
 *
 * Same as manual: no `terms`, so the scraper reads the main list and keeps its daily rotation, and the
 * window follows the frequency rather than the manual `since` — a weekly run with past-24h would never
 * see six days of posts. Its own: its terms, cards and window, the main terms when it names none.
 */
export function scheduledArgs(cfg: StoredSettings): { terms?: string, max?: number, since: Since } {
  const s = cfg.schedule
  if (!s.own) return { since: s.every === 'daily' || s.every === 'twice-daily' ? 'past-24h' : 'past-week' }
  return { ...(s.terms.length ? { terms: s.terms.join(',') } : {}), max: s.max, since: s.since }
}
