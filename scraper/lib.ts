// Pure helpers ported from the original jobfinder.js. No browser, no database, no API — so the Nitro
// server, the scraper child process and `npm test` can all import them.
import { createHash } from 'node:crypto'
import { tldsFor, withAliases } from '../shared/countries.ts'
import type { Constraints, Profile, StoredSettings } from '../shared/settings.ts'

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
// `immediate-start` was removed when this was retargeted: Mohamed can start immediately, and a flag would
// demote such posts in both the UI sort and the drafter queue for what is now an advantage.
export const FLAG_RULES: Record<string, RegExp> = {
  'residency-gate': /transferable (iqama|qid|visa|sponsorship)|locally available|local(ly)?[- ](candidates?|applicants?|based)( only)?|must (have|hold|be) (a )?(valid )?(work (permit|authori[sz]ation)|resident|residency)|visa[- ]independent|(inside|within) (the )?(uae|ksa|qatar|saudi|kuwait|bahrain|oman)( only)?\b|(uae|ksa|qatar|saudi)[- ]based (candidates?|applicants?) only|work authori[sz]ation (is )?(required|mandatory)/i,
  'night-shift': /night shifts?|\b(us|uk|est|pst|cst|ist|eastern|pacific) (shift|hours|timings?|time ?zone|working hours)\b|rotational shifts?/i,
  'junior': /\bfresh(ers?|\s+graduates?)\b|\bjuniors?\b|\bintern(ship)?s?\b|\bentry[- ]level\b|\btrainees?\b/i,
  // Frontend searches surface heavy WordPress/Shopify piecework; that experience is 2014-2017 and dated.
  'wordpress-only': /\b(wordpress|woocommerce|shopify)\b(?![^.]*\b(react|vue|nuxt|next\.?js|headless)\b)/i
}

export function prescreen(text: string, _emails: string[] = []): string[] {
  const flags = Object.entries(FLAG_RULES).filter(([, re]) => re.test(text)).map(([f]) => f)
  // required experience: only year phrases tied to experience wording, so "we grew 3x in 2 years" does not
  // count; take the largest number of each "N-M years" / "N+ years" phrase ("+" counts as two more).
  const YRS = /(\d{1,2})\s*(\+)?\s*(?:-|–|to)?\s*(\d{1,2})?\s*(\+)?\s*(?:years?|yrs?)/.source
  const re = new RegExp(`(?:experience|exp)\\s*[:\\-–]?\\s*${YRS}|${YRS}(?:\\s+of)?\\s+(?:experience|exp\\b|hands-on|relevant)`, 'gi')
  const yrs = [...text.matchAll(re)].map((m) => {
    const [a, plus, b, plus2] = m[1] !== undefined ? [m[1], m[2], m[3], m[4]] : [m[5], m[6], m[7], m[8]]
    return Math.max(Number(a), Number(b || 0)) + (plus || plus2 ? 2 : 0)
  })
  if (yrs.length && Math.max(...yrs) <= 5) flags.push('junior-years')
  return flags
}

// ---------------- scoring prompt ----------------

const STACK_RULE: Record<Constraints['stackWeighting'], string> = {
  'vue-primary': 'Vue/Nuxt roles are the best fit and score highest. React/Next roles score well but one point lower when they demand more React years than the CV shows. Angular-only roles score mid at best: that experience is dated.',
  'equal': 'Vue/Nuxt and React/Next roles are equally good fits and score the same.',
  'react-primary': 'React/Next roles are the best fit and score highest. Vue/Nuxt roles score well but one point lower.'
}

export function systemPrompt(cv: string, config: Config): string {
  const { constraints: c, titles } = config
  // aliases inline ('UAE (United Arab Emirates, Emirates)') so the model matches whichever form the
  // post text happens to use
  const onsite = withAliases(c.onsiteCountries)
  const tlds = tldsFor(c.onsiteCountries)
  return `You screen LinkedIn job posts for one candidate. Extract fields from the post text and score how well the post matches the candidate's CV, 0-10.
Candidate CV:
"""
${cv}
"""
Candidate target titles: ${titles.join('; ')}.
Location scope: ${c.remoteAnywhere ? 'genuinely location-free remote roles from anywhere, plus ' : ''}on-site or hybrid roles in ${onsite}. ${c.willRelocate.length ? `The candidate will relocate to ${withAliases(c.willRelocate)}.` : 'The candidate will not relocate.'} On-site or hybrid roles in any country not named above are out of scope and score 0-2 however good the stack match.
${STACK_RULE[c.stackWeighting]}
Non-software-engineering roles (mechanical, electrical, civil, MEP, construction, sales engineering, procurement, QA/QC, BIM) score 0-2 regardless of title words. Pure UI/UX design, graphic design and pure backend/data roles also score 0-2: this candidate builds frontends.
is_remote: true only if the post says remote or work from home.
is_in_scope: true if the location, the company, or${tlds.length ? ` the contact email domain (${tlds.join(' ')}) or` : ''} anything else in the post points to one of the countries named above, or the role is genuinely location-free remote.
score: 9-10 the role fits the CV's seniority, stack and domain and the location fits; 6-8 strong stack match with one gap (seniority a step off, adjacent stack, location unclear); 3-5 related software role with a major gap; 0-2 unrelated or out of location scope.
Credit a skill, tool, standard or domain only if the CV text explicitly contains it; never infer or assume it. Anything the post asks for that the CV does not mention is a gap.
Use "unknown" for strings you cannot find. reason: one sentence in the form "Match: <what the CV shows that the post asks for>; Gaps: <what the post asks for that the CV lacks, or none>".`
}

export const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'company', 'location', 'is_remote', 'is_in_scope', 'score', 'reason'],
  properties: {
    title: { type: 'string' },
    company: { type: 'string' },
    location: { type: 'string' },
    is_remote: { type: 'boolean' },
    is_in_scope: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 10 },
    reason: { type: 'string' }
  }
} as const
