// Pure SQL-text builders for /api/posts, kept out of the handler so `node --test` can run them against
// a real SQLite: the handler imports Drizzle and the server's db, which no test here can load.
import { locationMatches } from '../../shared/countries.ts'

export const SORTS = ['default', 'score', 'title', 'posted', 'added'] as const
export type Sort = typeof SORTS[number]
export type Dir = 'asc' | 'desc'

const COLUMN: Record<Exclude<Sort, 'default'>, string> = {
  score: 'posts.score',
  title: 'lower(posts.title)',
  posted: 'posts.posted_at',
  added: 'posts.scraped_at'
}

/**
 * ORDER BY for the Posts view. Flagged-last is the first key under every sort: the drafter queue
 * excludes flagged posts outright, so floating them up would mix undraftable rows into a triage pass.
 * NULLs go last in both directions (a pasted post has no posted_at). `posts.key` makes paging stable.
 * Only allowlisted literals are interpolated, which is what makes this safe for sql.raw().
 */
export function orderSql(sort: Sort, dir: Dir): string {
  const flaggedLast = 'json_array_length(posts.flags) > 0'
  if (sort === 'default') return `${flaggedLast}, posts.score DESC, posts.posted_at DESC, posts.key`
  const col = COLUMN[sort]
  return `${flaggedLast}, ${col} IS NULL, ${col} ${dir === 'asc' ? 'ASC' : 'DESC'}, posts.key`
}

/**
 * WHERE text for the country filter. `location` is free text from the scoring model, so the mapping to
 * countries runs in JS over the distinct values (~440) and the result is bound as one JSON array — one
 * placeholder however many locations match. NULL needs its own branch both ways: `NULL IN (...)` and
 * `NULL NOT IN (...)` are both NULL, so an exclude would otherwise silently drop every unlocated post.
 */
export function countryClause(
  locations: (string | null)[],
  picked: string[],
  mode: 'include' | 'exclude'
): { sql: string, param: string } | null {
  if (!picked.length) return null
  const hit = locations.filter(l => l !== null && locationMatches(l, picked)) as string[]
  const nullHit = locationMatches(null, picked)
  const inList = 'posts.location IN (SELECT value FROM json_each(?))'
  const sql = mode === 'include'
    ? `(${inList}${nullHit ? ' OR posts.location IS NULL' : ''})`
    : nullHit
      ? `(posts.location IS NOT NULL AND NOT ${inList})`
      : `(posts.location IS NULL OR NOT ${inList})`
  return { sql, param: JSON.stringify(hit) }
}
