import { and, eq, isNotNull, isNull, like, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { applications, contacts, posts } from '../db/schema'
import { neverWrittenTo } from '../utils/contacts'
import { db } from '../utils/db'
import { orderSql, SORTS } from '../utils/posts-query'

const query = z.object({
  q: z.string().trim().max(200).optional(),
  /**
   * clean = no pre-screen flags; flagged = at least one; excluded = caught by the owner's own
   * exclude list. `excluded` is the audit view for a blunt tool — it answers "what did my rule
   * actually catch", which is the only way to notice a needle that is too broad.
   */
  flags: z.enum(['all', 'clean', 'flagged', 'excluded']).default('all'),
  /** hiring = real vacancies (NULL counts, it predates the column); other = job seekers and non-jobs */
  type: z.enum(['hiring', 'all', 'other']).default('hiring'),
  scope: z.enum(['all', 'in-scope', 'remote']).default('all'),
  /** 'dismissed' is the only value that shows dismissed posts; every other one hides them. */
  status: z.enum(['all', 'unprocessed', 'drafted', 'skipped', 'dismissed', 'applied']).default('all'),
  // over `channels`, the routes a post really offers — not `links`/`phones`, which record what the card
  // carried. A post kept for its email still stores the marketing link beside it.
  channel: z.enum(['all', 'email', 'link', 'phone']).default('all'),
  minScore: z.coerce.number().int().min(0).max(10).default(0),
  /** Within the last N days; 0 = any. `posted` drops posts with no posted_at (pasted, and the odd undated card). */
  posted: z.coerce.number().int().min(0).max(365).default(0),
  added: z.coerce.number().int().min(0).max(365).default(0),
  // .catch, not .default: a junk value from a bookmarked URL falls back instead of answering 400
  sort: z.enum(SORTS).catch('default'),
  dir: z.enum(['asc', 'desc']).catch('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
})

export default defineEventHandler(async (event) => {
  const p = await getValidatedQuery(event, query.parse)

  const where = [
    p.minScore > 0 ? sql`${posts.score} >= ${p.minScore}` : undefined,
    // both columns are epoch seconds
    p.posted > 0 ? sql`${posts.postedAt} >= unixepoch() - ${p.posted * 86400}` : undefined,
    p.added > 0 ? sql`${posts.scrapedAt} >= unixepoch() - ${p.added * 86400}` : undefined,
    p.flags === 'clean' ? sql`json_array_length(${posts.flags}) = 0` : undefined,
    p.type === 'hiring' ? sql`coalesce(${posts.postType}, 'hiring') = 'hiring'` : undefined,
    p.type === 'other' ? sql`${posts.postType} in ('seeking', 'other')` : undefined,
    p.flags === 'flagged' ? sql`json_array_length(${posts.flags}) > 0` : undefined,
    p.flags === 'excluded' ? sql`EXISTS (SELECT 1 FROM json_each(${posts.flags}) WHERE value = 'excluded')` : undefined,
    p.scope === 'in-scope' ? eq(posts.inScope, true) : undefined,
    p.scope === 'remote' ? eq(posts.remote, true) : undefined,
    p.status === 'unprocessed' ? isNull(applications.key) : undefined,
    p.status === 'drafted' ? eq(applications.verdict, 'drafted') : undefined,
    p.status === 'skipped' ? eq(applications.verdict, 'skipped') : undefined,
    // Dismissed posts are out of every other view, 'all' included — 'all' means every live post.
    p.status === 'dismissed' ? isNotNull(posts.dismissedAt) : isNull(posts.dismissedAt),
    // Applied posts are different: they stay visible under 'all', because the owner wants to see what
    // they sent. Only 'unprocessed' — the queue of what is still to do — drops them.
    p.status === 'applied' ? isNotNull(posts.appliedAt) : undefined,
    p.status === 'unprocessed' ? isNull(posts.appliedAt) : undefined,
    // Nor a post whose recruiter was already written to about another role: that one is not waiting on
    // the owner, the follow-up carries it. Still under 'all', showing the stage. A subquery rather than
    // the contacts join below, which the count query does not carry.
    p.status === 'unprocessed' ? sql.raw(neverWrittenTo('posts')) : undefined,
    p.channel !== 'all'
      ? sql`EXISTS (SELECT 1 FROM json_each(${posts.channels}) WHERE value = ${p.channel})`
      : undefined,
    p.q
      ? or(
          like(posts.title, `%${p.q}%`),
          like(posts.company, `%${p.q}%`),
          like(posts.author, `%${p.q}%`),
          like(posts.text, `%${p.q}%`)
        )
      : undefined
  ].filter(Boolean)

  const rows = await db
    .select({
      key: posts.key,
      scrapedAt: posts.scrapedAt,
      searchTerm: posts.searchTerm,
      author: posts.author,
      authorUrl: posts.authorUrl,
      postUrl: posts.postUrl,
      postedAge: posts.postedAge,
      postedAt: posts.postedAt,
      postType: posts.postType,
      title: posts.title,
      company: posts.company,
      location: posts.location,
      remote: posts.remote,
      inScope: posts.inScope,
      emails: posts.emails,
      links: posts.links,
      phones: posts.phones,
      refIds: posts.refIds,
      channels: posts.channels,
      score: posts.score,
      reason: posts.reason,
      text: posts.text,
      flags: posts.flags,
      dismissedAt: posts.dismissedAt,
      appliedAt: posts.appliedAt,
      verdict: applications.verdict,
      verdictReason: applications.reason,
      stage: contacts.stage
    })
    .from(posts)
    .leftJoin(applications, eq(applications.key, posts.key))
    // The recruiter's stage, by the post's first address — the one the drafter groups by, and already
    // lower-case from extraction. `email` is the primary key, so this never multiplies a row, and the
    // count below needs no such join.
    .leftJoin(contacts, sql`${contacts.email} = json_extract(${posts.emails}, '$[0]')`)
    .where(where.length ? and(...where) : undefined)
    // flagged last under every sort — see orderSql
    .orderBy(sql.raw(orderSql(p.sort, p.dir)))
    .limit(p.limit)
    .offset(p.offset)

  const counted = await db
    .select({ total: sql<number>`count(*)` })
    .from(posts)
    .leftJoin(applications, eq(applications.key, posts.key))
    .where(where.length ? and(...where) : undefined)

  return { rows, total: counted[0]?.total ?? 0 }
})
