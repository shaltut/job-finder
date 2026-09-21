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
import { groupFor, modeStatus, type GapTerm } from '../../shared/gaps.ts'
import type Database from 'better-sqlite3'

type Db = Database.Database

/** What counts as an application, everywhere: drafted by the app, or applied to by hand. */
const IS_APPLICATION = `(a.verdict = 'drafted' OR p.applied_at IS NOT NULL)`

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

/**
 * Application posts not yet read against this CV: drafted by the app, or applied to by hand. Newest
 * application first, so a backfill that is stopped part-way has read the posts that matter most.
 */
export function pendingApplications(db: Db, cvSha: string): { key: string, text: string }[] {
  return db.prepare(`
    SELECT p.key, p.text FROM posts p
    LEFT JOIN applications a ON a.key = p.key
    LEFT JOIN requirement_runs r ON r.key = p.key
    WHERE ${IS_APPLICATION}
      AND (r.key IS NULL OR r.cv_sha <> ?)
    ORDER BY coalesce(p.applied_at, a.created_at) DESC
  `).all(cvSha) as { key: string, text: string }[]
}

export interface GapRunMeta { cvSha: string, model: string, dropped: number }

/** Replaces the post's rows and its run in one transaction, so a post is never half old CV, half new. */
export function storeRun(db: Db, key: string, kept: RawRequirement[], meta: GapRunMeta): void {
  db.transaction(() => {
    db.prepare('DELETE FROM post_requirements WHERE key = ?').run(key)
    const insert = db.prepare(`
      INSERT INTO post_requirements (key, term, category, importance, status, quote, cv_shows)
      VALUES (@key, @term, @category, @importance, @status, @quote, @cvShows)
    `)
    for (const r of kept) {
      insert.run({ key, term: r.term, category: r.category, importance: r.importance, status: r.status, quote: r.quote, cvShows: r.cvShows })
    }
    db.prepare(`
      INSERT INTO requirement_runs (key, cv_sha, model, kept, dropped, extracted_at)
      VALUES (@key, @cvSha, @model, @kept, @dropped, unixepoch())
      ON CONFLICT (key) DO UPDATE SET
        cv_sha = excluded.cv_sha, model = excluded.model, kept = excluded.kept,
        dropped = excluded.dropped, extracted_at = excluded.extracted_at
    `).run({ key, cvSha: meta.cvSha, model: meta.model, kept: kept.length, dropped: meta.dropped })
  })()
}

export interface GapsDeps {
  /** the model call: the post and the CV text in, the raw verdict table out */
  ask: (postText: string, cvText: string) => Promise<RawRequirement[]>
  cvText: string
  cvSha: string
  model: string
}

/**
 * Reads every pending application once. A failed call writes nothing, so the post is simply pending
 * again next time — the posture a failed score has. `stored < pending` is how the caller knows to exit 1.
 */
export async function extractGaps(
  db: Db, deps: GapsDeps, push: (line: string) => void, signal?: AbortSignal
): Promise<{ stored: number, pending: number }> {
  const pending = pendingApplications(db, deps.cvSha)
  if (!pending.length) {
    push('gaps: every application is already read against the current CV')
    return { stored: 0, pending: 0 }
  }
  push(`gaps: ${pending.length} application(s) to read with ${deps.model}`)
  let stored = 0
  for (const p of pending) {
    if (signal?.aborted) {
      push('stopped')
      break
    }
    const id = p.key.slice(0, 8)
    let raw: RawRequirement[]
    try {
      raw = await deps.ask(p.text, deps.cvText)
    } catch (e) {
      push(`${id}: ${(e as Error).message} — left for the next run`)
      continue
    }
    const { kept, dropped } = verifyRequirements(raw, p.text, deps.cvText)
    storeRun(db, p.key, kept, { cvSha: deps.cvSha, model: deps.model, dropped: dropped.length })
    stored++
    // An empty table is valid against the strict schema, which is exactly how nano failed on this task:
    // say so rather than let it read as a post that asks for nothing.
    if (!raw.length) {
      push(`${id}: the model returned no requirements at all — if this repeats, set JOBFINDER_GAPS_MODEL to a stronger model`)
    } else {
      const why = [...new Set(dropped.map(d => d.why))].join('; ')
      push(`${id}: ${kept.length} kept${dropped.length ? `, ${dropped.length} dropped (${why})` : ''}`)
    }
  }
  push(`gaps: ${stored} of ${pending.length} read`)
  return { stored, pending: pending.length }
}

/** One requirement row of one application post, with what the page shows beside it. */
export interface GapRow {
  key: string
  term: string
  category: string
  importance: RequirementImportance
  status: RequirementStatus
  quote: string
  cvShows: string
  title: string | null
  company: string | null
  postUrl: string | null
  /** epoch seconds: the draft's created_at, or applied_at for a post applied to by hand */
  appliedAt: number | null
}

/**
 * Every stored requirement of every application post. Filtered on the application predicate again, not
 * just on the rows existing: a post un-marked applied keeps its rows, and must stop being ranked.
 */
export function requirementRows(db: Db): GapRow[] {
  return db.prepare(`
    SELECT r.key, r.term, r.category, r.importance, r.status, r.quote, r.cv_shows AS cvShows,
           p.title, p.company, p.post_url AS postUrl,
           coalesce(CASE WHEN a.verdict = 'drafted' THEN a.created_at END, p.applied_at) AS appliedAt
    FROM post_requirements r
    JOIN posts p ON p.key = r.key
    LEFT JOIN applications a ON a.key = p.key
    WHERE ${IS_APPLICATION}
  `).all() as GapRow[]
}

/** How many applications exist, and how many were read against the CV with this sha. */
export function applicationCounts(db: Db, cvSha: string): { applications: number, analysed: number } {
  return db.prepare(`
    SELECT count(*) AS applications, count(r.key) AS analysed
    FROM posts p
    LEFT JOIN applications a ON a.key = p.key
    LEFT JOIN requirement_runs r ON r.key = p.key AND r.cv_sha = ?
    WHERE ${IS_APPLICATION}
  `).get(cvSha) as { applications: number, analysed: number }
}

const mostFrequent = (xs: string[]): string => {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n.entries()].reduce((best, e) => (e[1] > best[1] ? e : best))[0]
}

const iso = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString() : null)

/**
 * Terms across applications, grouped case-insensitively and ranked by how many applications ask, then how
 * many make it a must-have. `cvText` is the CURRENT master CV, so "on your CV" follows a CV update before
 * any re-extraction. The match is excludeRule()'s: whole words where \b can see the edge, so `C#` and
 * `.NET` still match and `Go` does not match "Google".
 */
export function aggregateGaps(rows: GapRow[], cvText: string): GapTerm[] {
  const byTerm = new Map<string, GapRow[]>()
  for (const r of rows) {
    const id = r.term.toLowerCase()
    byTerm.set(id, [...(byTerm.get(id) ?? []), r])
  }
  return [...byTerm.values()].map((rs): GapTerm => {
    const term = mostFrequent(rs.map(r => r.term))
    const inCv = !!cvText && !!excludeRule([term])?.test(cvText)
    const last = Math.max(...rs.map(r => r.appliedAt ?? 0))
    return {
      term,
      category: mostFrequent(rs.map(r => r.category)),
      group: groupFor(modeStatus(rs.map(r => r.status)), inCv),
      applications: new Set(rs.map(r => r.key)).size,
      must: new Set(rs.filter(r => r.importance === 'must').map(r => r.key)).size,
      lastSeen: iso(last || null),
      posts: rs.map(r => ({
        key: r.key, title: r.title, company: r.company, postUrl: r.postUrl, importance: r.importance,
        status: r.status, quote: r.quote, cvShows: r.cvShows, appliedAt: iso(r.appliedAt)
      }))
    }
  }).sort((a, b) => b.applications - a.applications || b.must - a.must || a.term.localeCompare(b.term))
}
