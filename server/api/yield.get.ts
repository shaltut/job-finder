import { sql } from 'drizzle-orm'
import { db } from '../utils/db'

/**
 * Yield by search term: the table that decides which terms earn their place. The original tuned nine
 * terms down from a list that produced 74 posts and 1 usable role in a day, using exactly this query.
 */
export default defineEventHandler(async () => {
  return await db.all<{ term: string, posts: number, usable: number, drafted: number }>(sql`
    SELECT
      coalesce(p.search_term, 'unknown') AS term,
      count(*)                            AS posts,
      count(*) FILTER (WHERE p.score >= 6
        AND coalesce(p.post_type, 'hiring') = 'hiring'
        AND json_array_length(p.flags) = 0
        AND (p.in_scope = 1 OR p.remote = 1)) AS usable,
      count(a.key) FILTER (WHERE a.verdict = 'drafted') AS drafted
    FROM posts p
    LEFT JOIN applications a ON a.key = p.key
    GROUP BY 1
    ORDER BY usable DESC, posts DESC
  `)
})
