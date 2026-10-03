import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Ported from the original Postgres `schema.sql`. Three translations matter:
 *   text[]        -> text({ mode: 'json' })   read back with json_each / json_array_length
 *   timestamptz   -> integer({ mode: 'timestamp' })
 *   lower() check -> CHECK (email = lower(email))
 */

export const posts = sqliteTable('posts', {
  /**
   * sha1(author_url + the first 160 chars of the post BODY, drifting header markers stripped) — the
   * body being whatever follows the card's Follow marker, or the whole text when a card carries none.
   * Rows written before 2026-09-18 hash the header too; `legacyKey` in scraper/lib.ts still recognises
   * them, which is why changing this needed no migration.
   */
  key: text('key').primaryKey(),
  scrapedAt: integer('scraped_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  searchTerm: text('search_term'),
  author: text('author'),
  authorUrl: text('author_url'),
  /**
   * Permalink to the post itself. Null when the scrape could not resolve one: the rendered DOM carries no
   * URN, so it is recovered from the page's own React-server payload (see `urnMap` in scraper/lib.ts), and
   * the home feed offers no card-to-URN association at all.
   */
  postUrl: text('post_url'),
  /** LinkedIn's relative age as scraped ('5h', '2d'); postedAt pins it to an instant. */
  postedAge: text('posted_age'),
  postedAt: integer('posted_at', { mode: 'timestamp' }),
  /**
   * Who is posting, from the scoring model: 'hiring' | 'seeking' | 'other'. Only 'hiring' is a job — a
   * peer's "I'm #OpenToWork" post is the best possible CV match, which is why it used to score 7 and sit
   * at the top of the drafter queue. NULL means the row was scored before this column existed, and every
   * consumer reads it as `coalesce(post_type, 'hiring')` so a migration does not empty the UI.
   */
  postType: text('post_type').$type<'hiring' | 'seeking' | 'other'>(),
  title: text('title'),
  company: text('company'),
  location: text('location'),
  remote: integer('remote', { mode: 'boolean' }),
  /** Was `mena`. The scope is now Egypt + Saudi + UAE + Qatar + location-free remote. */
  inScope: integer('in_scope', { mode: 'boolean' }),
  /** Deterministic regex output, never the model's. */
  emails: text('emails', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`),
  /**
   * External links on the card. Regex + DOM anchors, never the model's. NOT `post_url`: that is this
   * post's own LinkedIn permalink, while these point away from LinkedIn. The destination is unknowable
   * — LinkedIn rewrites every outbound URL to an opaque `lnkd.in` hash — which is why `channels` below
   * decides whether one of these is an application route, and this column stays a plain record of what
   * the card carried.
   */
  links: text('links', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`),
  /** Contact numbers, normalised to digits with a leading '+' where the post gave one. Regex, never the model's. */
  phones: text('phones', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`),
  /** Requisition identifiers. Shown to the reader; never a contact channel and never an admission reason. */
  refIds: text('ref_ids', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`),
  /**
   * The contact routes this post actually offers, from `channelsOf()` in scraper/lib.ts — the subset of
   * the three columns above that a person could really apply through. Stored rather than derived at
   * query time because extraction is unconditional while admission is not: a post kept for its email
   * still records the marketing link it happened to carry, so `json_array_length(links) > 0` would be a
   * lie in the UI. Writing the computed set once keeps the scraper gate, the Posts badge and the
   * channel filter from drifting apart.
   */
  channels: text('channels', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`),
  /** 0-10 from the scoring model. An ordering hint, never a verdict. */
  score: integer('score'),
  /** "Match: ...; Gaps: ...". Model-generated and prone to overclaiming; never copy into an email. */
  reason: text('reason'),
  text: text('text').notNull(),
  /** Regex pre-screen hints mirroring the drafter's hard skips. */
  flags: text('flags', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`),
  /**
   * When the owner dismissed this post from the Posts view; NULL means it is still live. Triage, not a
   * verdict: it is orthogonal to `applications`, so a post that already has a draft can be dismissed too.
   * Every query that decides who receives an email carries `dismissed_at IS NULL` — the drafter queue and
   * the follow-up sweep — and the insert's `ON CONFLICT DO NOTHING` is what makes a dismissal survive a
   * re-scrape.
   */
  dismissedAt: integer('dismissed_at', { mode: 'timestamp' }),
  /**
   * When the owner applied to this post by hand, through its link or number; NULL means they have not.
   * The same shape as `dismissed_at` and for the same reason: it is the owner's own triage, not a third
   * `applications` verdict. A verdict would break the follow-up sweep, which finds unmentioned roles by
   * the ABSENCE of a `named in ...` reason and would read a manual row as a role still to be pitched.
   * Every query that decides who receives an email carries `applied_at IS NULL` beside `dismissed_at`.
   */
  appliedAt: integer('applied_at', { mode: 'timestamp' })
}, t => [
  index('posts_score_idx').on(t.score),
  index('posts_posted_at_idx').on(t.postedAt),
  index('posts_search_term_idx').on(t.searchTerm)
])

/** One row per post the drafter or the UI has touched. A post with a row is never shown as unprocessed again. */
export const applications = sqliteTable('applications', {
  key: text('key').primaryKey().references(() => posts.key, { onDelete: 'cascade' }),
  verdict: text('verdict', { enum: ['drafted', 'skipped'] }).notNull(),
  /**
   * For drafted posts this MUST start with 'named in application' or 'named in follow-up'.
   * The follow-up query looks for that prefix to find posts no sent email has mentioned yet.
   */
  reason: text('reason'),
  recruiterEmail: text('recruiter_email'),
  gmailDraftId: text('gmail_draft_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, t => [
  index('applications_recruiter_idx').on(t.recruiterEmail)
])

/**
 * One row per recruiter address. Two emails per address, ever: the application and one follow-up.
 * Gmail (sent mail) is the truth for 'contacted'; this table caches the stage. 'final' is never reset.
 */
export const contacts = sqliteTable('contacts', {
  email: text('email').primaryKey(),
  stage: text('stage', {
    enum: ['drafted', 'contacted', 'followed_up', 'replied', 'final']
  }).notNull(),
  threadId: text('thread_id'),
  lastSentAt: integer('last_sent_at', { mode: 'timestamp' }),
  note: text('note'),
  /**
   * The CV this recruiter was sent when it was a tailored one; null means the uploaded PDF went out.
   * Recorded rather than derived from the recruiter: a later re-draft that falls back would otherwise
   * leave the old tailored file on disk, looking like what was sent. The follow-up reuses it.
   */
  cvPath: text('cv_path'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, t => [
  // Addresses are lower-cased before any query or insert; the database refuses anything else.
  check('contacts_email_lower', sql`${t.email} = lower(${t.email})`)
])

/**
 * One row per requirement an application post states, judged against the master CV. Written only by the
 * `gaps` job (server/utils/gaps.ts), and only rows whose quotes survived verification: `quote` is in the
 * post, and `cv_shows` is in the master CV unless the status is `absent`, when it is ''. The status
 * vocabulary is shared/background.ts's — one meaning of "partial" in this codebase, not two.
 */
export const postRequirements = sqliteTable('post_requirements', {
  key: text('key').notNull().references(() => posts.key, { onDelete: 'cascade' }),
  /** the keyword as a CV would write it; unique per post case-insensitively, enforced in code */
  term: text('term').notNull(),
  category: text('category', { enum: ['technology', 'domain', 'certification', 'practice', 'language', 'other'] }).notNull(),
  importance: text('importance', { enum: ['must', 'nice'] }).notNull(),
  status: text('status', { enum: ['present', 'partial', 'absent'] }).notNull(),
  quote: text('quote').notNull(),
  cvShows: text('cv_shows').notNull().default('')
}, t => [
  primaryKey({ columns: [t.key, t.term] })
])

/**
 * One row per post the gaps job has read, and against which CV. It is what tells "done, nothing stated"
 * from "not attempted", and what makes a new CV visible: a run whose `cv_sha` differs from the current
 * CV's is stale and gets read again.
 */
export const requirementRuns = sqliteTable('requirement_runs', {
  key: text('key').primaryKey().references(() => posts.key, { onDelete: 'cascade' }),
  /** pdfSha256 of the CV this post was read against */
  cvSha: text('cv_sha').notNull(),
  model: text('model').notNull(),
  /** rows stored / rows the checks discarded — a rising drop count is a drifting prompt */
  kept: integer('kept').notNull(),
  dropped: integer('dropped').notNull(),
  extractedAt: integer('extracted_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
})

export type Post = typeof posts.$inferSelect
export type NewPost = typeof posts.$inferInsert
export type Application = typeof applications.$inferSelect
export type Contact = typeof contacts.$inferSelect
export type Stage = Contact['stage']

/**
 * The profile, constraints and search settings — one row, ever. Replaces config.json, which was
 * git-tracked and therefore carried real contact details into a repository.
 *
 * One JSON column rather than normalised tables on purpose: nothing queries an individual setting,
 * every consumer wants the whole object, and splitting it would buy nothing while costing a rewrite
 * of the Settings PUT. Plain text, not mode:'json' — the scraper and the server read this through a
 * raw better-sqlite3 handle (see shared/settings.ts), so the parse is explicit at both ends and
 * cannot double-encode.
 */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey().default(1),
  json: text('json').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, t => [
  check('settings_single_row', sql`${t.id} = 1`)
])

export type Settings = typeof settings.$inferSelect

/**
 * The job queue, durable. jobs.ts keeps the live queue in memory and mirrors every change here, so a
 * Nitro worker rebuild (any server file edit) or a restart no longer loses it — measured 2026-10-01, one
 * edit dropped a running draft and 18 queued. `started_at` set means the job was running when the
 * worker died; server/plugins/queue.ts restores the table at boot (queue-core.ts restorePlan()).
 * Rides in the cross-machine hand-off snapshot like any other table.
 */
export const jobQueue = sqliteTable('job_queue', {
  id: integer('id').primaryKey(),
  lane: text('lane').notNull(),
  kind: text('kind').notNull(),
  args: text('args').notNull(),
  queuedAt: text('queued_at').notNull(),
  startedAt: text('started_at')
})
