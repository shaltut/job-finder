// Pure helpers ported from the original jobfinder.js. No browser, no database, no API — so the Nitro
// server, the scraper child process and `npm test` can all import them.
import { createHash } from 'node:crypto'
import { homeCountryOf, nameFormsFor, resolveCountry, tldsFor, withAliases } from '../shared/countries.ts'
import { emptySettings } from '../shared/settings.ts'
import type { Profile, Scope, StoredSettings } from '../shared/settings.ts'

// These used to be declared here as a third copy of the same shape, kept in sync by hand with the
// server's Zod schema and the browser's types. One definition now, in shared/settings.ts.
export type { Constraints, Profile }
export type Config = StoredSettings

// ---------------- emails ----------------

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi
// LinkedIn innerText glues sentences: 'hr@acme.com.Apply now' -> drop a capitalised word riding on the domain
const trimLabel = (e: string) => e.replace(/\.([A-Z][a-z]+)$/, '')

export const extractEmails = (text: string, mailtos: string[] = []): string[] =>
  [...new Set([...mailtos, ...(text.match(EMAIL_RE) || []).map(trimLabel)].map(e => e.toLowerCase()))]

// ---------------- post permalinks ----------------

// LinkedIn's rendered DOM carries no post URN: cards are hashed markup, and the only id on a card is
// `expanded<token>FeedType_...`, where <token> is an opaque per-post hash we cannot turn into a URL.
// The URN is still shipped — in the React-server payload that renders the page — so the scraper reads
// the response bodies and builds the token -> URN map here. Measured, not guessed: in that payload each
// card contributes a state block whose `UpdateState<token>` key is preceded by that same post's
// `reactionState-urn:li:...`, so the last URN before the anchor is the card's own. Verified across five
// live payloads (14 cards, every one resolved, no two sharing a URN) — "nearest URN" was tried first and
// was wrong, mapping every card on a page to a single URN.
/**
 * The opaque per-post token in a card's DOM id, or null. The id belongs to the post's expandable-text
 * block and is rendered in either state, so both prefixes count: `expanded<token>FeedType_X` and
 * `collapsed<token>FeedType_X`. A post short enough to need no "…more" has neither, and gets no URL.
 */
export const tokenFromId = (id: string | null | undefined): string | null =>
  /^(?:expanded|collapsed)([A-Za-z0-9_-]{20,60})FeedType_[A-Z_]+$/.exec(id ?? '')?.[1] ?? null

/**
 * token -> post URN, parsed out of one React-server payload. Entries are merged across responses by the
 * caller: the first page arrives in the search document, later ones in the pagination endpoint.
 *
 * Search payloads interleave one state block per card, so the URN immediately before a card's
 * `UpdateState<token>` key is that card's own. **The home feed does not**: there every `UpdateState` key
 * is packed into one consecutive array whose values are just "Expanded"/"Collapsed", with the URNs
 * elsewhere and no association to recover — measured, and the reason `feed` posts are left with no URL
 * rather than a guessed one. `resolveUrls` is the second line of defence if that ever slips.
 */
export function urnMap(body: string): Map<string, string> {
  const out = new Map<string, string>()
  // one pass, document order: remember the most recent URN, and claim it when its UpdateState key arrives
  const scan = /urn:li:(?:activity|ugcPost|share):\d+|UpdateState([A-Za-z0-9_-]{20,60})/g
  let urn: string | null = null
  for (const m of body.matchAll(scan)) {
    if (!m[1]) urn = m[0]
    else if (urn && !out.has(m[1])) out.set(m[1], urn)
  }
  return out
}

/**
 * Card tokens -> permalinks, dropping any URN that two cards on the same page both claim. A duplicate means
 * the pairing slipped, and one of the two links is certainly wrong; a wrong permalink is worse than none,
 * because it points at the post next to the job. Both are dropped rather than guessed between.
 *
 * The guard is per call, so it sees one term's cards: a post mispaired under one search term and paired
 * correctly under another would not be caught, since nothing constrains post_url to be unique.
 */
export function resolveUrls(tokens: (string | null)[], urns: Map<string, string>): (string | null)[] {
  const claimed = tokens.map(t => urns.get(tokenFromId(t) ?? '') ?? null)
  const seen = new Map<string, number>()
  for (const u of claimed) if (u) seen.set(u, (seen.get(u) ?? 0) + 1)
  return claimed.map(u => (u && seen.get(u) === 1 ? postUrlFrom(u) : null))
}

/** The public permalink for a post URN. Null for anything that is not one, so a bad parse stores nothing. */
export const postUrlFrom = (urn: string | null | undefined): string | null =>
  /^urn:li:(?:activity|ugcPost|share):\d+$/.test(urn ?? '')
    ? `https://www.linkedin.com/feed/update/${urn}/`
    : null

// ---------------- dedupe key ----------------

// Card text starts with a header that drifts between runs ("5h" -> "1d", Follow -> Following, Edited),
// so strip those markers and collapse whitespace before hashing.
const keyText = (t: string) => t
  .replace(/\b\d+\s?(mo|m|h|d|w)\b|\bEdited\b|\bFollow(ing)?\b|• (1st|2nd|3rd\+)/g, '')
  .replace(/\s+/g, ' ')
  .slice(0, 160)

// ponytail: the 160 chars still include the author's headline, so a headline edit re-keys their posts.
export const dedupeKey = (authorUrl: string, text: string): string =>
  createHash('sha1').update(authorUrl + keyText(text)).digest('hex')

// ---------------- locale ----------------

// LinkedIn renders part of the home feed in the account's language whatever locale Chrome asks for,
// which blanks the age and drifts the dedupe key. Fold the Arabic age back into English: '٣ من الساعات' -> '3h'.
const AR_UNIT: Record<string, string> = {
  ثانية: 'm', الثواني: 'm', دقيقة: 'm', الدقائق: 'm', ساعة: 'h', الساعات: 'h',
  يوم: 'd', الأيام: 'd', أسبوع: 'w', الأسابيع: 'w', شهر: 'mo', الشهور: 'mo'
}
const MARKS = '[\\s‎‏؜⁦-⁩]*' // RTL/isolate marks sit between the digits and the unit
const AR_AGE = new RegExp(`(\\d+)${MARKS}(?:من${MARKS})?(${Object.keys(AR_UNIT).join('|')})`, 'g')

// ponytail: only the age is folded, so the same post still keys twice when the two render paths disagree
// about the wrapper ('Feed post' vs 'منشور في سجل الأنشطة'). Rare; the email is identical either way.
export const normalize = (t: string): string => t
  .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
  .replace(AR_AGE, (_, n, u) => n + AR_UNIT[u])

export const ageOf = (t: string): string => (t.match(/\b\d+\s?(mo|m|h|d|w)\b/) || [''])[0]

// ---------------- time ----------------

const AGE_MS: Record<string, number> = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, mo: 30 * 86400e3 }

/** LinkedIn only shows a relative age; pin it to an absolute instant at scrape time. */
export const postedAt = (age: string | null | undefined, at: Date = new Date()): Date | null => {
  const m = /^(\d+)\s?(mo|m|h|d|w)$/.exec((age || '').trim())
  return m ? new Date(at.getTime() - Number(m[1]) * AGE_MS[m[2]!]!) : null
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const rand = (a: number, b: number) => a + Math.random() * (b - a)

export const searchUrl = (term: string, since: string) =>
  `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(term)}&datePosted=%5B%22${since}%22%5D`

// ---------------- pre-screen ----------------

// Deterministic red flags mirroring the drafter's hard skips. Hints for ordering and display, never verdicts.
// Personal email addresses (gmail etc.) are deliberately NOT a flag: much real Egyptian and Gulf recruiting
// runs on them.
//
// `immediate-start` is deliberately absent: whether an immediate start is a problem depends on the
// candidate, not the posting, and a flag would demote such posts in both the UI sort and the drafter
// queue for what is an advantage to anyone who can take it. The real availability is injected into
// the drafter prompt from `constraints.canStartImmediately`.
export const FLAG_RULES: Record<string, RegExp> = {
  // Phrases that gate on residency or work authorisation WITHOUT naming a country. True for anyone,
  // anywhere — the country-specific half is derived per install in flagRules() below.
  'residency-gate': /transferable (iqama|qid|visa|sponsorship)|locally available|local(ly)?[- ](candidates?|applicants?|based)( only)?|must (have|hold|be) (a )?(valid )?(work (permit|authori[sz]ation)|resident|residency)|visa[- ]independent|work authori[sz]ation (is )?(required|mandatory)|\b(nationals?|citizens?) only\b/i,
  // Shift work as such. The "US hours"/"IST timings" half is derived in flagRules(): a US-hours post
  // is not a night shift for somebody living in the US, and flagging it would empty their queue.
  'night-shift': /night shifts?|graveyard shift|shift work|rotational shifts?/i,
  // The author advertising themselves rather than a vacancy: a peer's self-description is the best possible
  // match for any CV, which is exactly why it used to score 7. First person on purpose — the scored text
  // includes the LinkedIn card header, and a bare /open to work/ buries a genuine req posted by someone
  // whose own headline ends '| Open to Work'. 'available for' is narrowed for the same reason: a recruiter
  // writes "I'm available for any questions". Both apostrophes: LinkedIn emits ASCII and typographic.
  //
  // DO NOT GENERALISE THIS ONE. It is already profession-neutral, it was tuned against real stored
  // posts, and its regression corpus is backups/pre-wipe-2026-09-13.db, where it must fire on exactly
  // three rows and no others.
  'seeking-work': /\bI(?:'m|\u2019m| am)\s+(?:currently\s+)?(?:#?open[ _]?to[ _]?(?:work|opportunities)|actively (?:seeking|looking)|looking for (?:my next|a new)|available for (?:hire|freelance|work|new opportunities|immediate))|\bservices I offer\b|\b(?:hire|refer) me\b|\bmy (?:cv|resume) is attached\b/i
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Time-zone demands that are only a night shift for somebody outside that region. Three entries is
 * enough: these are the coverage demands that actually appear in postings.
 */
const TZ_DEMANDS: { tokens: string, codes: string[] }[] = [
  // alpha-2 codes, not display names: the display name for US is 'USA', and matching on prose here
  // fails silently — the rule simply keeps firing for someone who lives in that region.
  { tokens: 'us|est|pst|cst|eastern|pacific', codes: ['US', 'CA'] },
  { tokens: 'uk|gmt|bst|british', codes: ['GB', 'IE'] },
  { tokens: 'ist|india', codes: ['IN', 'LK'] }
]

/**
 * The rules that only exist once the settings say who this is. Merged onto FLAG_RULES by name, so a
 * stored `flags` value keeps meaning across the change.
 *
 * Every one of these fails OPEN — an unset setting produces no rule rather than a broad one. That is
 * deliberate: a flag removes a post from the drafter queue outright (jobs.ts: `json_array_length(flags) = 0`),
 * so a false positive costs a lead while a false negative only costs a sort position.
 */
export function flagRules(config: Config): Record<string, RegExp> {
  const rules: Record<string, RegExp> = {}
  const home = homeCountryOf(config.profile.location)

  // "UAE-based candidates only" is a gate only if the candidate is NOT UAE-based, and onsiteCountries
  // is by definition where they WOULD work — including where they live. Deriving from it directly
  // would flag every posting in their own city.
  const away = [...config.constraints.onsiteCountries, ...config.constraints.willRelocate]
    .filter((n) => {
      if (!home) return true
      const c = resolveCountry(n)
      return !c || c.code !== home.code // compare codes: 'UAE' and 'United Arab Emirates' are one country
    })
  const forms = nameFormsFor(away).map(escapeRe)
  if (forms.length) {
    const alt = forms.join('|')
    rules['residency-gate'] = new RegExp(
      `(?:inside|within|based in|located in|resident in)\\s+(?:the\\s+)?(?:${alt})\\b`
      + `|(?:${alt})[- ]based\\s+(?:candidates?|applicants?)\\s+only`, 'i')
  }

  const foreign = TZ_DEMANDS.filter(d => !home || !d.codes.includes(home.code))
  if (foreign.length) {
    rules['night-shift'] = new RegExp(
      `\\b(?:${foreign.map(d => d.tokens).join('|')}) (?:shift|hours|timings?|time ?zone|working hours)\\b`, 'i')
  }

  // Someone whose floor is one or two years IS in the market these postings serve; flagging them
  // would hide every suitable post from a graduate.
  if (config.scope.seniorityFloor >= 3) {
    rules['junior'] = /\bfresh(ers?|\s+graduates?)\b|\bjuniors?\b|\bintern(ship)?s?\b|\bentry[- ]level\b|\btrainees?\b/i
  }
  return rules
}

export function prescreen(text: string, config: Config = emptySettings()): string[] {
  const rules = { ...FLAG_RULES }
  for (const [name, re] of Object.entries(flagRules(config))) {
    // same name, so a derived rule widens the static one rather than shadowing it
    rules[name] = name in rules ? new RegExp(`${rules[name]!.source}|${re.source}`, 'i') : re
  }
  const flags = Object.entries(rules).filter(([, re]) => re.test(text)).map(([f]) => f)
  // required experience: only year phrases tied to experience wording, so "we grew 3x in 2 years" does not
  // count; take the largest number of each "N-M years" / "N+ years" phrase ("+" counts as two more).
  const YRS = /(\d{1,2})\s*(\+)?\s*(?:-|–|to)?\s*(\d{1,2})?\s*(\+)?\s*(?:years?|yrs?)/.source
  const re = new RegExp(`(?:experience|exp)\\s*[:\\-–]?\\s*${YRS}|${YRS}(?:\\s+of)?\\s+(?:experience|exp\\b|hands-on|relevant)`, 'gi')
  const yrs = [...text.matchAll(re)].map((m) => {
    const [a, plus, b, plus2] = m[1] !== undefined ? [m[1], m[2], m[3], m[4]] : [m[5], m[6], m[7], m[8]]
    return Math.max(Number(a), Number(b || 0)) + (plus || plus2 ? 2 : 0)
  })
  const floor = config.scope.seniorityFloor
  if (floor > 0 && yrs.length && Math.max(...yrs) <= floor) flags.push('junior-years')
  return flags
}

// ---------------- scoring prompt ----------------

/**
 * Replaces a closed Vue/React enum. Each clause disappears when its list is empty, so a fresh install
 * gets no weighting sentence at all rather than a confidently wrong one. The wording is carried over
 * from the enum deliberately — it was tuned against this model, and only the stack names are new.
 */
export function skillRule(s: Scope): string {
  const out: string[] = []
  if (s.primarySkills.length) {
    out.push(`Roles built on ${s.primarySkills.join(', ')} are the best fit and score highest.`)
  }
  if (s.secondarySkills.length) {
    out.push(`Roles built on ${s.secondarySkills.join(', ')} score well, but one point lower when they demand more depth in them than the CV shows.`)
  }
  return out.join(' ')
}

/**
 * Replaces "this candidate builds frontends" and a hardcoded list of engineering disciplines. The
 * exclusions matter more than they look: the model latches onto a title word like "engineer", and
 * naming the neighbouring professions is what holds it. Empty list, no clause.
 */
export function fieldRule(s: Scope): string {
  if (!s.roleFamily) return ''
  const ex = s.excludedRoles.length
    ? ` In particular, ${s.excludedRoles.join(', ')} roles score 0-2 even when the title words match.`
    : ''
  return `The candidate's field is ${s.roleFamily}. Roles outside that field score 0-2 regardless of title words: judge by the work the post describes, not by words in the title.${ex}`
}

export function systemPrompt(cv: string, config: Config): string {
  const { constraints: c, titles } = config
  // aliases inline ('UAE (United Arab Emirates, Emirates)') so the model matches whichever form the
  // post text happens to use
  const onsite = withAliases(c.onsiteCountries)
  const tlds = tldsFor(c.onsiteCountries)
  // filtered so an unset setting leaves no blank line, and no rule with a hole in it
  const rules = [skillRule(config.scope), fieldRule(config.scope)].filter(Boolean).join('\n')
  return `You screen LinkedIn job posts for one candidate. Extract fields from the post text and score how well the post matches the candidate's CV, 0-10.
Candidate CV:
"""
${cv}
"""
Candidate target titles: ${titles.join('; ')}.
Location scope: ${c.remoteAnywhere ? 'genuinely location-free remote roles from anywhere, plus ' : ''}on-site or hybrid roles in ${onsite}. ${c.willRelocate.length ? `The candidate will relocate to ${withAliases(c.willRelocate)}.` : 'The candidate will not relocate.'} On-site or hybrid roles in any country not named above are out of scope and score 0-2 however good the skill match.
${rules}
is_remote: true only if the post says remote or work from home.
is_in_scope: true if the location, the company, or${tlds.length ? ` the contact email domain (${tlds.join(' ')}) or` : ''} anything else in the post points to one of the countries named above, or the role is genuinely location-free remote.
score: 9-10 the role fits the CV's seniority, skills and domain and the location fits; 6-8 strong skill match with one gap (seniority a step off, adjacent skills, location unclear); 3-5 a related role in the same field with a major gap; 0-2 unrelated or out of location scope.
Credit a skill, tool, standard or domain only if the CV text explicitly contains it; never infer or assume it. Anything the post asks for that the CV does not mention is a gap.
Use "unknown" for strings you cannot find. reason, for a hiring post: one sentence in the form "Match: <what the CV shows that the post asks for>; Gaps: <what the post asks for that the CV lacks, or none>".
Finally, post_type — who is posting. The text you were given starts with the LinkedIn card header (the author's name, their profile headline, the age, "Connect" or "Follow"); judge the body, not the header, and never take the title or company from the header.
- "hiring": the author is advertising a vacancy, their own company's or a client's. Someone else would apply. An author whose own headline says "Open to Work" may still be posting a real vacancy for their employer — that is still "hiring".
- "seeking": the author is advertising themselves — open to work, looking for their next role, available for hire, or offering freelance services. The author would be the applicant and the contact address is their own.
- "other": neither. News, a course or bootcamp ad, a tool or security advisory, general networking.
If post_type is not "hiring", that overrides everything above: score 0, is_remote false, is_in_scope false, company and location "unknown", title the role the author is seeking or "unknown", and reason one sentence naming what the post actually is. Do not score skill overlap in that case — a peer's self-description matches this CV almost perfectly, and that is the mistake this field exists to prevent.`
}

/**
 * The scoring model's own "if it is not hiring, score 0" instruction is only sometimes obeyed: measured over
 * five rescores of the same 21 posts, the post_type classification never moved and the score it was told to
 * pin did. So the arithmetic happens here instead of being asked for — the same discipline as `emails`,
 * which is regex output and never the model's. A non-hiring post cannot carry a score, a location verdict,
 * or a place in any ranking.
 */
export function gateOnPostType<T extends { post_type: string, score: number, is_remote: boolean, is_in_scope: boolean }>(s: T): T {
  return s.post_type === 'hiring' ? s : { ...s, score: 0, is_remote: false, is_in_scope: false }
}

export const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // strict mode requires every property to be listed here, so post_type is never optional
  required: ['post_type', 'title', 'company', 'location', 'is_remote', 'is_in_scope', 'score', 'reason'],
  properties: {
    /** Who is posting. Only 'hiring' is a job; the rest are filtered out downstream. */
    post_type: { type: 'string', enum: ['hiring', 'seeking', 'other'] },
    title: { type: 'string' },
    company: { type: 'string' },
    location: { type: 'string' },
    is_remote: { type: 'boolean' },
    is_in_scope: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 10 },
    reason: { type: 'string' }
  }
} as const
