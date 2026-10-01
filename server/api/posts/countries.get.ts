import { isNull, sql } from 'drizzle-orm'
import { countriesIn, NO_COUNTRY } from '../../../shared/countries'
import { posts } from '../../db/schema'
import { db } from '../../utils/db'

/** The country picker's options: every country the live posts' locations name, with counts. */
export default defineEventHandler(async () => {
  const rows = await db
    .select({ l: posts.location, n: sql<number>`count(*)` })
    .from(posts)
    .where(isNull(posts.dismissedAt))
    .groupBy(posts.location)
  const counts = new Map<string, number>()
  let none = 0
  for (const r of rows) {
    const cs = countriesIn(r.l)
    if (!cs.length) none += r.n
    // a multi-country location counts toward each country it names
    for (const c of cs) counts.set(c, (counts.get(c) ?? 0) + r.n)
  }
  return [
    ...[...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    { name: NO_COUNTRY, count: none }
  ]
})
