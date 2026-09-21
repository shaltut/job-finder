import { sql } from 'drizzle-orm'
import { neverWrittenTo } from '../utils/contacts'
import { db } from '../utils/db'
import { PASTED_TERM } from '../utils/paste'

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
      -- total counts every row regardless of origin, dismissals included: it measures the whole table,
      -- not the triage. Only the two actionable numbers below drop a dismissed post.
      (SELECT count(*) FROM posts) AS total,
      -- 'usable' is the funnel that matters: someone is actually hiring, it scores well, no pre-screen
      -- flag, and somewhere the owner can work. Both triage columns drop out of it: this number is what
      -- is still waiting for you, and a post you applied to by hand is no longer waiting. coalesce: NULL post_type predates the column, so it
      -- counts. dismissed_at: a headline number that disagrees with the list underneath it is noise.
      (SELECT count(*) FROM posts
        WHERE score >= 6 AND coalesce(post_type, 'hiring') = 'hiring'
          AND json_array_length(flags) = 0 AND (in_scope = 1 OR remote = 1)
          AND dismissed_at IS NULL AND applied_at IS NULL) AS usable,
      (SELECT count(*) FROM posts p LEFT JOIN applications a ON a.key = p.key
        WHERE a.key IS NULL AND coalesce(p.post_type, 'hiring') = 'hiring'
          AND json_array_length(p.flags) = 0 AND p.dismissed_at IS NULL
          AND p.applied_at IS NULL
          -- the same clause as the Posts view's Unprocessed, so this number is the length of that list
          AND ${sql.raw(neverWrittenTo('p'))}) AS unprocessed,
      -- Both figures below measure the scraper, so a pasted row (search_term = 'pasted') is excluded from
      -- each; coalesce guards the comparison because search_term is nullable in the schema, so a bare
      -- <> comparison would silently drop any row that happens to carry NULL there.
      (SELECT count(*) FROM posts WHERE scraped_at >= unixepoch() - 86400
        AND coalesce(search_term, '') <> ${PASTED_TERM}) AS last24h,
      (SELECT count(*) FROM applications WHERE verdict = 'drafted') AS drafted,
      (SELECT max(scraped_at) FROM posts WHERE coalesce(search_term, '') <> ${PASTED_TERM}) AS scrapedAt
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
