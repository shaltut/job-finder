import { sql } from 'drizzle-orm'
import { db } from '../utils/db'

/** The KPI strip. One round trip, four numbers that answer "is this pipeline working?". */
export default defineEventHandler(async () => {
  const [row] = await db.all<{
    total: number
    usable: number
    unprocessed: number
    last24h: number
    drafted: number
    scrapedAt: number | null
  }>(sql`
    SELECT
      (SELECT count(*) FROM posts) AS total,
      -- 'usable' is the funnel that matters: someone is actually hiring, it scores well, no pre-screen
      -- flag, and somewhere he can work. coalesce: NULL post_type predates the column, so it counts.
      (SELECT count(*) FROM posts
        WHERE score >= 6 AND coalesce(post_type, 'hiring') = 'hiring'
          AND json_array_length(flags) = 0 AND (in_scope = 1 OR remote = 1)) AS usable,
      (SELECT count(*) FROM posts p LEFT JOIN applications a ON a.key = p.key
        WHERE a.key IS NULL AND coalesce(p.post_type, 'hiring') = 'hiring'
          AND json_array_length(p.flags) = 0) AS unprocessed,
      (SELECT count(*) FROM posts WHERE scraped_at >= unixepoch() - 86400) AS last24h,
      (SELECT count(*) FROM applications WHERE verdict = 'drafted') AS drafted,
      (SELECT max(scraped_at) FROM posts) AS scrapedAt
  `)

  return {
    total: row?.total ?? 0,
    usable: row?.usable ?? 0,
    unprocessed: row?.unprocessed ?? 0,
    last24h: row?.last24h ?? 0,
    drafted: row?.drafted ?? 0,
    lastScrapeAt: row?.scrapedAt ? new Date(row.scrapedAt * 1000).toISOString() : null
  }
})
