// The Posts view's Location cell: one standardized answer to "where is this job, and how is it worked",
// from the scoring model's free-text `posts.location` (852 distinct strings over 2,037 hiring posts,
// measured 2026-10-03). See docs/superpowers/specs/2026-10-03-location-indicator-design.md.
//
// Display only. Pure and browser-safe. Never guesses a country from an email domain or a phone code:
// measured, those named the agency's country rather than the job's in 20 posts.
import { COUNTRIES, countriesIn, hasWord, regionIn, resolveCountry, wordAt } from './countries.ts'

export type WorkMode = 'remote' | 'hybrid' | 'onsite'

export interface Place {
  /** Resolved countries in the order countriesIn() finds them; empty when none. */
  countries: { name: string, flag: string }[]
  /** One spelling per city ("Bengaluru"), null when the location names none. */
  city: string | null
  /** "Middle East", "APAC"… — only when no country resolves. */
  region: string | null
  mode: WorkMode | null
  /** The mode came from the post body because the location and the remote flag said nothing. */
  modeFromText: boolean
  /** False for an empty or "unknown" location — a post that never said where it is. */
  stated: boolean
}

/** ISO alpha-2 -> flag emoji (two regional-indicator symbols). */
export const flagOf = (code: string): string =>
  String.fromCodePoint(...[...code.toUpperCase()].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65))

const UNSTATED = new Set(['', 'unknown', 'n/a', 'na', 'not specified', 'not stated', 'unspecified', 'tbd', 'none', '-'])

// earliest mention wins: "Clevedon, hybrid (3 days onsite)" is hybrid
const MODE_WORDS: [string, WorkMode][] = [
  ['remote', 'remote'], ['work from home', 'remote'], ['wfh', 'remote'],
  ['hybrid', 'hybrid'],
  ['on-site', 'onsite'], ['onsite', 'onsite'], ['on site', 'onsite'], ['in office', 'onsite'], ['in-office', 'onsite'], ['office-based', 'onsite']
]
// A body says "remote" about teams, access and tools far more often than about the job, so only the two
// words that are rarely anything but a work arrangement are read from it.
const BODY_MODES = MODE_WORDS.filter(([, m]) => m !== 'remote')

function firstMode(text: string, words: [string, WorkMode][]): WorkMode | null {
  let best: { at: number, mode: WorkMode } | null = null
  for (const [w, mode] of words) {
    const at = wordAt(text, w)
    if (at >= 0 && (!best || at < best.at)) best = { at, mode }
  }
  return best?.mode ?? null
}

const CITY_CANON: Record<string, string> = {
  bangalore: 'Bengaluru', bengaluru: 'Bengaluru', gurgaon: 'Gurugram', trivandrum: 'Thiruvananthapuram',
  bombay: 'Mumbai', madras: 'Chennai'
}

const titleCase = (s: string) => s.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())

/** The first comma segment, when it is a place rather than a country, a region, a mode or "unknown". */
function cityOf(location: string): string | null {
  const seg = (location.split(/[,،/|]/)[0] ?? '').replace(/\(.*?\)/g, '').trim()
  if (!seg || UNSTATED.has(seg.toLowerCase())) return null
  if (resolveCountry(seg) || regionIn(seg) || firstMode(seg, MODE_WORDS)) return null
  if (COUNTRIES.some(c => [c.name, ...c.aliases].some(f => hasWord(seg, f)))) return null
  const canon = CITY_CANON[seg.toLowerCase()]
  if (canon) return canon
  return seg === seg.toLowerCase() ? titleCase(seg) : seg
}

export function placeOf(location: string | null, body: string | null, remoteFlag: boolean | null): Place {
  const l = (location ?? '').trim()
  const stated = !UNSTATED.has(l.toLowerCase())
  const countries = stated
    ? countriesIn(l).map(name => ({ name, flag: flagOf(resolveCountry(name)?.code ?? '') }))
    : []
  const fromLocation = stated ? firstMode(l, MODE_WORDS) : null
  const fromFlag = !fromLocation && remoteFlag ? 'remote' as const : null
  const fromBody = !fromLocation && !fromFlag && body ? firstMode(body, BODY_MODES) : null
  return {
    countries,
    city: stated ? cityOf(l) : null,
    region: countries.length ? null : (stated ? regionIn(l) : null),
    mode: fromLocation ?? fromFlag ?? fromBody,
    modeFromText: !!fromBody,
    stated
  }
}
