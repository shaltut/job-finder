// The gap record: what the posts the owner applies to ask for, judged against the master CV.
//
// Test-importable on purpose — explicit .ts imports, nothing that reaches ./db, ./config or ./jobs — so
// the checks that decide what survives, the selection and the aggregation run under node:test without a
// network. The OpenAI call and the job wiring live in gaps-job.ts.
//
// THE RISK THIS FILE CONTAINS is shared/background.ts's: a requirement the post never stated, or a
// "present" the CV does not support, steers the CV rewrite and the learning plan wrong. So the model fills
// in a verdict table and code drops every row it cannot justify, with quotes checked verbatim on BOTH
// sides — the post, and the CV.
import { excludeRule } from '../../scraper/lib.ts'
import { matchKey } from './cv-master.ts'

export const REQUIREMENT_CATEGORIES = ['technology', 'domain', 'certification', 'practice', 'language', 'other'] as const
export type RequirementCategory = typeof REQUIREMENT_CATEGORIES[number]
export type RequirementImportance = 'must' | 'nice'
export type RequirementStatus = 'present' | 'partial' | 'absent'

/** One row as the model returns it. Nothing here is trusted until verifyRequirements() has seen it. */
export interface RawRequirement {
  term: string
  category: RequirementCategory
  importance: RequirementImportance
  quote: string
  status: RequirementStatus
  cvShows: string
}

export interface DroppedRequirement { row: RawRequirement, why: string }

/**
 * At or above this many letters and digits a quote is compared loosely; below it, as a whole word. Short
 * quotes are the common case, not an edge: a third of the skills on the real CV are under 8 ("C#",
 * "Redis", "AWS"), and posts list requirements as bare bullets.
 */
export const MIN_QUOTE = 8

export const REQUIREMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'category', 'importance', 'quote', 'status', 'cvShows'],
        properties: {
          term: { type: 'string' },
          category: { type: 'string', enum: [...REQUIREMENT_CATEGORIES] },
          importance: { type: 'string', enum: ['must', 'nice'] },
          quote: { type: 'string' },
          status: { type: 'string', enum: ['present', 'partial', 'absent'] },
          cvShows: { type: 'string' }
        }
      }
    }
  }
} as const

/** The system prompt. The post comes first and the CV second, so requirements are read, not invented. */
export function requirementsInstructions(): string {
  return `You are reading one job post the candidate has applied to, beside their CV, to record what the
post asks for and whether the CV shows it. The record decides what they learn next and how they improve
their CV, so an invented requirement or a generous "present" does real damage. Returning less is better.

Work from the POST first. List every skill, technology, domain, certification, practice or spoken
language the post states as a requirement or a preference, and nothing it does not state. Then look for
each one in the CV.

For each requirement:
  term       - the keyword as a CV would write it, in its common canonical form: "React", not "ReactJS"
               or "React.js developer"; "Kubernetes", not "K8s". One concept per entry.
  category   - technology (languages, frameworks, tools, platforms, databases, clouds), domain (an
               industry or business area), certification, practice (a methodology or way of working),
               language (a spoken language), or other.
  importance - "must" when the post states it as required; "nice" when it says preferred, a plus, nice
               to have or bonus. When the post does not say, "must".
  quote      - the post's own words that state it, copied exactly; a bullet's own words are enough. An
               entry whose quote is not in the post is discarded.
  status     - "present": the CV plainly shows it. "partial": the CV shows some of it, less of it, an
               older version of it, or something adjacent. "absent": the CV does not show it anywhere.
  cvShows    - for "present" and "partial", the CV's own words that settle it, copied exactly. For
               "absent", the empty string. An "absent" entry that quotes the CV is a contradiction and is
               discarded, and so is a "present" or "partial" entry whose words are not in the CV.

Do not list years of experience, a seniority level, a location, a salary or working hours: those are not
skills. Do not list a requirement in order to be able to mark it absent.`
}

interface Source { raw: string, key: string }

/**
 * Is this quote in the source? A long one is compared on letters and digits only (matchKey), so a line
 * wrap, a bullet glyph or a changed dash cannot hide it. A short one would match inside anything that way
 * — "go" is in "google" — so it must appear as a whole word, excludeRule()'s way: boundaries only where
 * \b can see the edge, which keeps `C#` and `.NET` matchable.
 */
function found(quote: string, src: Source): boolean {
  const key = matchKey(quote)
  if (!key) return false
  return key.length >= MIN_QUOTE ? src.key.includes(key) : !!excludeRule([quote])?.test(src.raw)
}

/** Why this row may not be stored, or null when it may. Order matters only for the message. */
function rejection(r: RawRequirement, term: string, post: Source, cv: Source, seen: Set<string>): string | null {
  if (!term) return 'no term'
  if (seen.has(term.toLowerCase())) return 'duplicate term'
  if (!found(String(r.quote ?? '').trim(), post)) return 'quote not found in the post'
  const shows = String(r.cvShows ?? '').trim()
  if (r.status === 'absent') return shows ? 'marked absent but quotes the CV' : null
  if (r.status !== 'present' && r.status !== 'partial') return 'unknown status'
  if (!shows) return `${r.status} with no CV quote`
  if (!found(shows, cv)) return 'CV quote not found in the CV'
  return null
}

/**
 * The rows that survive. Every drop is returned with its reason rather than swallowed, so the job log can
 * count them — a rising drop count is how a drifting prompt gets noticed.
 */
export function verifyRequirements(
  rows: RawRequirement[], postText: string, cvText: string
): { kept: RawRequirement[], dropped: DroppedRequirement[] } {
  const post: Source = { raw: postText, key: matchKey(postText) }
  const cv: Source = { raw: cvText, key: matchKey(cvText) }
  const kept: RawRequirement[] = []
  const dropped: DroppedRequirement[] = []
  const seen = new Set<string>()

  for (const r of Array.isArray(rows) ? rows : []) {
    const term = String(r?.term ?? '').trim().slice(0, 60)
    const why = rejection(r, term, post, cv, seen)
    if (why) {
      dropped.push({ row: r, why })
      continue
    }
    seen.add(term.toLowerCase())
    kept.push({
      ...r,
      term,
      quote: String(r.quote).trim(),
      cvShows: r.status === 'absent' ? '' : String(r.cvShows).trim()
    })
  }
  return { kept, dropped }
}
