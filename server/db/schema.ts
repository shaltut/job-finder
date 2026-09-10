import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Ported from the original Postgres `schema.sql`. Three translations matter:
 *   text[]        -> text({ mode: 'json' })   read back with json_each / json_array_length
 *   timestamptz   -> integer({ mode: 'timestamp' })
 *   lower() check -> CHECK (email = lower(email))
 */

export const posts = sqliteTable('posts', {
  /** sha1(author_url + first 160 chars of text, drifting header markers stripped). */
  key: text('key').primaryKey(),
  scrapedAt: integer('scraped_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  searchTerm: text('search_term'),
  author: text('author'),
  authorUrl: text('author_url'),
  /** LinkedIn's relative age as scraped ('5h', '2d'); postedAt pins it to an instant. */
  postedAge: text('posted_age'),
  postedAt: integer('posted_at', { mode: 'timestamp' }),
  title: text('title'),
  company: text('company'),
  location: text('location'),
  remote: integer('remote', { mode: 'boolean' }),
  /** Was `mena`. The scope is now Egypt + Saudi + UAE + Qatar + location-free remote. */
  inScope: integer('in_scope', { mode: 'boolean' }),
  /** Deterministic regex output, never the model's. */
  emails: text('emails', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`),
  /** 0-10 from the scoring model. An ordering hint, never a verdict. */
  score: integer('score'),
  /** "Match: ...; Gaps: ...". Model-generated and prone to overclaiming; never copy into an email. */
  reason: text('reason'),
  text: text('text').notNull(),
  /** Regex pre-screen hints mirroring the drafter's hard skips. */
  flags: text('flags', { mode: 'json' }).$type<string[]>().notNull().default(sql`('[]')`)
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
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, t => [
  // Addresses are lower-cased before any query or insert; the database refuses anything else.
  check('contacts_email_lower', sql`${t.email} = lower(${t.email})`)
])

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
