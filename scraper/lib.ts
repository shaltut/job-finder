// Pure helpers ported from the original jobfinder.js. No browser, no database, no API — so the Nitro
// server, the scraper child process and `npm test` can all import them.
import { createHash } from 'node:crypto'
import { homeCountryOf, nameFormsFor, resolveCountry, tldsFor, withAliases } from '../shared/countries.ts'
import { emptySettings } from '../shared/settings.ts'
import type { ContactChannel, Constraints, Profile, Scope, StoredSettings } from '../shared/settings.ts'

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

// ---------------- contact channels ----------------
// An email is the only contact route that reaches the drafter, but it is not the only one a post
// carries. These extractors are deterministic — regex over the card text plus the anchors the DOM
// reader hands over — for the same reason `emails` is: a contact detail invented by a model is a
// message sent to a stranger. The model never sees any of this.

// one definition, in the module the browser can import too
export { CONTACT_CHANNELS as CHANNELS } from '../shared/settings.ts'
export type Channel = ContactChannel

// LinkedIn's own hosts: every card links its author, the company, and each hashtag. `lnkd.in` is
// deliberately NOT here — that shortener is what an external link looks like once LinkedIn has
// rewritten it, and it is the only form an application link ever arrives in.
const LINKEDIN_HOST = /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com(?:[/?#]|$)/i
const URL_RE = /https?:\/\/[^\s<>"'`]+/g
// innerText runs a sentence into its link: 'apply at https://x.example/jobs.Thanks', '(https://…)'
const trimUrl = (u: string) => u.replace(/[.,;:!?)\]}>'"]+$/, '')

/**
 * External links on the card, DOM anchors first. The destination is NOT knowable from these: LinkedIn
 * rewrites every outbound URL to an opaque `lnkd.in` hash, in the href as well as the text, so nothing
 * here can tell a careers page from a blog post. That is why `channelsOf` gates on the prose instead.
 */
export const extractLinks = (text: string, hrefs: string[] = []): string[] =>
  [...new Set([...hrefs, ...(text.match(URL_RE) || [])].map(trimUrl))]
    .filter(u => u && !LINKEDIN_HOST.test(u))

// Two forms, because a bare run of digits is not a phone number — years, salaries and "5-7 years" all
// look like one. An international number carries its own proof in the leading '+'; a local one counts
// only where the prose calls it a way to reach somebody.
const PHONE_INTL = /\+[\s(]*\d[\d\s().-]{6,18}\d/g
// \b is ASCII-only in a JS regex, so it is on the Latin cues (or 'tel' would fire inside 'hotel') and
// deliberately off the Arabic ones, where it would never match at all.
const PHONE_CUED = /(?:\b(?:whatsapp|whats\s?app|telegram|telephone|tel|mobile|phone|call|contact)|واتساب|واتس|اتصل|تليفون|جوال|موبايل|رقم)[^\d\n]{0,20}(\d[\d\s().-]{7,18}\d)/gi
const WA_LINK = /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d{9,15})/i

/**
 * "send your CV to <number>" — a contact route with no word for a phone in it anywhere, which is how
 * recruiters in Egypt routinely post a WhatsApp number. PHONE_CUED cannot see it: every cue there is a
 * NOUN for a phone. Measured live on a search: a score-7 post read "send your resume to <number>",
 * extracted nothing, and was dropped for carrying no contact route at all.
 *
 * The connector (to/on/via/at/through) immediately before the digits is not decoration. Without it this
 * cue is loose enough to read "share your cv, salary 15000 - 20000 EGP" as a ten-digit number, because a
 * salary range has exactly the digits-and-separators shape of a phone number. Pinned by a test.
 */
const PHONE_SENDCV = /\b(?:send|share|drop|forward)\b[^\n]{0,30}?\b(?:cv|resume|profile)\b[^\d\n]{0,20}?\b(?:to|on|via|at|through)\b[^\d\n]{0,8}(\d[\d\s().-]{7,18}\d)/gi

/** Digits only, keeping a leading '+', or null when the run is too short or too long to be a number. */
function normalizePhone(raw: string): string | null {
  const plus = raw.trim().startsWith('+')
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) return null
  return plus ? `+${digits}` : digits
}

/** Contact numbers on the card. Deduped by digits, so one number written two ways is one number. */
export function extractPhones(text: string, hrefs: string[] = []): string[] {
  const byDigits = new Map<string, string>()
  const add = (raw: string) => {
    const p = normalizePhone(raw)
    if (!p) return
    const digits = p.replace(/\D/g, '')
    // the international form proves itself, so it wins over a cued local match of the same digits
    if (!byDigits.has(digits) || p.startsWith('+')) byDigits.set(digits, p)
  }
  for (const m of text.match(PHONE_INTL) || []) add(m)
  for (const m of text.matchAll(PHONE_CUED)) add(m[1]!)
  for (const m of text.matchAll(PHONE_SENDCV)) add(m[1]!)
  for (const h of hrefs) {
    const m = WA_LINK.exec(h)
    if (m) add(`+${m[1]}`)
  }
  return [...byDigits.values()]
}

// Narrow on purpose. The loose version of this returned 'Requirements', 'required' and 'Position:
// Frontend' out of the stored corpus and not one genuine identifier, so a label word alone is not
// enough: an explicit id-word, or a recognised prefix glued to digits, has to be there.
const REF_LABELLED = /\b(?:job|req(?:uisition)?|vacancy|position|posting)\s*(?:id|code|ref(?:erence)?|no\.?|number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,14})\b/gi
const REF_BARE = /\bref(?:erence)?\s*(?:no\.?|number|code|#)?\s*[:#]\s*([A-Z0-9][A-Z0-9-]{2,14})\b/gi
const REF_PREFIXED = /\b((?:REQ|JR|VAC|JOB)-?\d{3,})\b/g

/** Requisition identifiers. Metadata for the reader — never a contact channel, never an admission reason. */
export const extractRefIds = (text: string): string[] =>
  [...new Set([
    ...[...text.matchAll(REF_LABELLED)].map(m => m[1]!),
    ...[...text.matchAll(REF_BARE)].map(m => m[1]!),
    ...[...text.matchAll(REF_PREFIXED)].map(m => m[1]!)
  ].map(r => r.toUpperCase()))]

// The whole weight of link admission rests here, because the URL itself says nothing. Measured against
// the stored corpus: seven posts carried a link and none was an application link — they were vendor
// pitches ('tell us what engineers you need') and blog links. Every one of them fails this test.
const APPLY_CUE = /\bapply\s+(?:here|now|via|through|at|on|by|online|using|directly)\b|\bto\s+apply\b|\bapplication\s+link\b|\bapply\s+link\b|\bclick\s+(?:here|below|the\s+link)\b|\bregister\s+(?:here|now)\b|\bsubmit\s+your\s+(?:cv|resume|application)\b|\bfill\s+(?:in|out)\s+the\s+form\b|للتقديم|رابط\s*التقديم|قدم\s*من\s*هنا|التقديم\s*من\s*خلال/i

/** Does the post invite an application anywhere in its prose? */
export const hasApplyCue = (text: string): boolean => APPLY_CUE.test(text)

/**
 * How far before a link an apply cue still counts as pointing AT that link.
 *
 * Measured over the 11 link-bearing posts in the two stored corpora, which separate cleanly: the one
 * genuine apply link ('How to Apply … or <link>') sits 163 characters after its cue, and the one
 * false positive — a BBC Writers post whose link is introduced as "you can find the blog post here",
 * in prose that elsewhere says writers "need to apply separately" — sits 779. Every other link has no
 * cue before it at all.
 */
const CUE_WINDOW = 300

/**
 * Does an apply cue point at THIS link? A post can discuss applying and still link somewhere else, so
 * whole-text matching is not enough — it admitted the BBC blog link above. Only the window before the
 * link counts: "<link>, apply by email" is a link that is not the application route.
 *
 * A link the DOM handed over but the text never renders has no position to measure, so it falls back
 * to the whole-post test rather than being silently dropped.
 */
export function applyCueNear(text: string, link: string): boolean {
  return applyCueFor(text, link) !== null
}

/** The cue that admitted this link, or null. Same rule as applyCueNear — the dry run reports it, which
 *  is how you tune APPLY_CUE against real cards instead of against the ones already in the database. */
export function applyCueFor(text: string, link: string): string | null {
  const at = text.indexOf(link)
  const window = at < 0 ? text : text.slice(Math.max(0, at - CUE_WINDOW), at)
  return APPLY_CUE.exec(window)?.[0] ?? null
}

/**
 * The contact routes this post actually offers, in CHANNELS order.
 *
 * Extraction runs for every card whatever the settings say; only admission is configured. So a post
 * kept for its email still records the link and the number it carries, and this set — stored on the
 * row — is what the scraper gate, the Posts badge and the channel filter all read, so the three can
 * never drift apart.
 */
export function channelsOf(
  found: { emails: string[], links: string[], phones: string[] },
  text: string
): Channel[] {
  const out: Channel[] = []
  if (found.emails.length) out.push('email')
  if (found.links.some(l => applyCueNear(text, l))) out.push('link')
  if (found.phones.length) out.push('phone')
  return out
}

/** Keep the post? True when any route it offers is switched on in Settings. */
export const admits = (channels: readonly Channel[], enabled: readonly Channel[]): boolean =>
  channels.some(c => enabled.includes(c))

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

/**
 * How long the scroll loop waits for the card count to grow before deciding the results have run out.
 *
 * It used to give up after four iterations with no growth, which is time-blind: each iteration sleeps
 * 2-5s, so four of them is as little as EIGHT seconds of patience, and LinkedIn's lazy-load routinely
 * takes longer. Measured: one feed run stopped at 28 cards and reported that as the whole feed, while the
 * next run minutes later found 58 on the same feed. The longer wait is paid only by a term that genuinely
 * has fewer posts than `max`; a term that fills its quota never waits at all.
 */
/**
 * LinkedIn's soft block: the search page renders "Our systems have detected unusual search traffic coming
 * from your account" and returns no results at all.
 *
 * This is NOT a checkpoint, so the /login|authwall|checkpoint/ URL guard cannot see it — the URL stays on
 * /search/results/content/ and the page is a normal 200. Measured 2026-09-17: six configured terms each
 * logged "0 cards" in one afternoon after returning 15-20 posts each that morning, and the run walked on
 * to the next term every time, asking an account that had just been throttled for more. Treated like a
 * lost login (abort the whole run) rather than an empty term, because continuing is what does the damage.
 */
export const isThrottled = (text: string): boolean =>
  /unusual\s+(?:search\s+)?traffic|search activity on your account has been paused/i.test(text)

export const SCROLL_STALL_MS = 30_000

/** Keep scrolling while there is room for more cards and the count has grown recently enough. */
export const keepScrolling = (cards: number, max: number, msSinceGrowth: number): boolean =>
  cards < max && msSinceGrowth < SCROLL_STALL_MS

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
 * The owner's own exclude list, compiled to one alternation. Unlike `scope.excludedRoles`, which is
 * prose the scoring model is merely asked to honour, this is deterministic — the same reasoning that
 * put `gateOnPostType` in code rather than in the prompt.
 *
 * Matched against the whole post text, which begins with the LinkedIn card header. That is why one
 * list covers three things the owner might mean: a domain written in the prose, a company name, and
 * the name of a recruiter whose posts are never relevant.
 *
 * WORD BOUNDARIES ARE NOT OPTIONAL, and they are conditional on the needle's own edges. Measured over
 * the 42 stored posts: `ai` as a bare substring matches 36 of them and 9 with boundaries; `intern`
 * matches 12 and 7; `micro1.ai` matches 2 either way. But `\b` is ASCII-only in a JS regex — the same
 * trap `extractPhones` documents above — so a boundary is added only where the edge character is one
 * `\b` can see. Wrapping `C#` or an Arabic needle in `\b` would stop it matching anything at all.
 *
 * Fails OPEN, like every rule in flagRules(): an empty list yields null, never `/(?:)/`, which matches
 * every post and would silently empty the drafter queue.
 */
export function excludeRule(list: readonly string[]): RegExp | null {
  const parts = list.map(v => v.trim()).filter(Boolean).map((v) => {
    const lead = /^[A-Za-z0-9_]/.test(v) ? '\\b' : ''
    const tail = /[A-Za-z0-9_]$/.test(v) ? '\\b' : ''
    return `${lead}${escapeRe(v)}${tail}`
  })
  return parts.length ? new RegExp(parts.join('|'), 'i') : null
}

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

  // The owner's own list. Last because it is the only rule here they wrote themselves: the others
  // infer a rule from who they are, this one is a decision they already made.
  const excluded = excludeRule(config.excludes)
  if (excluded) rules['excluded'] = excluded

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
