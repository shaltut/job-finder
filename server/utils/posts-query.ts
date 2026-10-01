// Pure SQL-text builders for /api/posts, kept out of the handler so `node --test` can run them against
// a real SQLite: the handler imports Drizzle and the server's db, which no test here can load.

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
