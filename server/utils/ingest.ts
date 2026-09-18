// The single place scraper output becomes database rows. Used by the Nitro server (which spawns the
// scraper from the UI) and by scraper/ingest.ts (the CLI pipe), so both paths behave identically.
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

export type ScraperRecord
  = | ({ op: 'post' } & PostRecord)
    | { op: 'update', key: string, postType: PostType | null, title: string, company: string, location: string, remote: boolean, inScope: boolean, score: number, reason: string }
    | { op: 'reflag', key: string, flags: string[], postedAt: string | null }
    | { op: 'reextract', key: string, links: string[], phones: string[], refIds: string[], channels: string[] }
    | { op: 'posturl', key: string, postUrl: string }
    // `excluded` is only set by --reflag, which is the one mode that can count how many stored posts
    // the owner's exclude list now catches. The UI reports that number back after a settings save.
    | { op: 'done', added: number, excluded?: number }

/** Who is posting. Only 'hiring' is a job; null means a row scored before the column existed. */
export type PostType = 'hiring' | 'seeking' | 'other'

export interface PostRecord {
  key: string
  searchTerm: string
  author: string | null
  authorUrl: string | null
  postUrl: string | null
  postedAge: string | null
  postedAt: string | null
  postType: PostType | null
  title: string
  company: string
  location: string
  remote: boolean
  inScope: boolean
  emails: string[]
  links: string[]
  phones: string[]
  refIds: string[]
  channels: string[]
  score: number
  reason: string
  text: string
  flags: string[]
}

/** Seconds since the epoch — the unit drizzle's `{ mode: 'timestamp' }` columns store. */
const secs = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null)

export function openWritableDb(path = process.env.JOBFINDER_DB || 'data/jobfinder.db') {
  const file = resolve(process.cwd(), path)
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  return { db, close: () => db.close() }
}

/**
 * Applies one scraper record. Returns what it did, or null for records that carry no row change.
 * Inserts use ON CONFLICT DO NOTHING, so re-running a scrape never duplicates or overwrites a post.
 */
export function applyRecord(db: Database.Database, rec: ScraperRecord): 'post' | 'update' | null {
  if (rec.op === 'post') {
    const r = db.prepare(`
      INSERT INTO posts (key, search_term, author, author_url, post_url, posted_age, posted_at, post_type,
                         title, company, location, remote, in_scope, emails, links, phones, ref_ids,
                         channels, score, reason, text, flags)
      VALUES (@key, @searchTerm, @author, @authorUrl, @postUrl, @postedAge, @postedAt, @postType,
              @title, @company, @location, @remote, @inScope, @emails, @links, @phones, @refIds,
              @channels, @score, @reason, @text, @flags)
      ON CONFLICT (key) DO NOTHING
    `).run({
      key: rec.key,
      searchTerm: rec.searchTerm,
      author: rec.author,
      authorUrl: rec.authorUrl,
      postUrl: rec.postUrl ?? null, // better-sqlite3 throws on a missing named binding, and older NDJSON has none
      postedAge: rec.postedAge,
      postedAt: secs(rec.postedAt),
      postType: rec.postType ?? null, // same reason as postUrl: NDJSON written before this field has none
      title: rec.title,
      company: rec.company,
      location: rec.location,
      remote: rec.remote ? 1 : 0,
      inScope: rec.inScope ? 1 : 0,
      emails: JSON.stringify(rec.emails),
      links: JSON.stringify(rec.links),
      phones: JSON.stringify(rec.phones),
      refIds: JSON.stringify(rec.refIds),
      channels: JSON.stringify(rec.channels),
      score: rec.score,
      reason: rec.reason,
      text: rec.text,
      flags: JSON.stringify(rec.flags)
    })
    // A known post never reaches here twice in practice: the scraper skips it before scoring and emits
    // 'posturl' instead, which is the one path that backfills a URL. DO NOTHING keeps that true.
    return r.changes ? 'post' : null
  }

  if (rec.op === 'update') { // --rescore
    const r = db.prepare(`
      UPDATE posts SET post_type = @postType, title = @title, company = @company, location = @location,
                       remote = @remote, in_scope = @inScope, score = @score, reason = @reason
      WHERE key = @key
    `).run({
      key: rec.key,
      postType: rec.postType ?? null, // --rescore is the only path that backfills post_type onto old rows
      title: rec.title,
      company: rec.company,
      location: rec.location,
      remote: rec.remote ? 1 : 0,
      inScope: rec.inScope ? 1 : 0,
      score: rec.score,
      reason: rec.reason
    })
    return r.changes ? 'update' : null
  }

  if (rec.op === 'reflag') { // --reflag, and it backfills posted_at
    const r = db.prepare(`
      UPDATE posts SET flags = @flags, posted_at = coalesce(posted_at, @postedAt) WHERE key = @key
    `).run({ key: rec.key, flags: JSON.stringify(rec.flags), postedAt: secs(rec.postedAt) })
    return r.changes ? 'update' : null
  }

  if (rec.op === 'reextract') { // --reextract: fills the contact columns on rows stored before they existed
    // Names its columns, like reflag and update above, so the owner's own triage — dismissed_at and
    // applied_at — survives a backfill. test/dismiss.test.ts pins that for all of them.
    const r = db.prepare(`
      UPDATE posts SET links = @links, phones = @phones, ref_ids = @refIds, channels = @channels
      WHERE key = @key
    `).run({
      key: rec.key,
      links: JSON.stringify(rec.links),
      phones: JSON.stringify(rec.phones),
      refIds: JSON.stringify(rec.refIds),
      channels: JSON.stringify(rec.channels)
    })
    return r.changes ? 'update' : null
  }

  if (rec.op === 'posturl') { // a known post seen again, whose row predates permalinks or came from the feed
    const r = db.prepare(`UPDATE posts SET post_url = @postUrl WHERE key = @key AND post_url IS NULL`)
      .run({ key: rec.key, postUrl: rec.postUrl })
    return r.changes ? 'update' : null // never overwrites a URL already stored
  }

  return null // 'done' carries a count for the caller to report, not a row
}

/**
 * Dismisses (or restores) posts from the Posts view — the owner's triage, not the drafter's verdict.
 * Takes a handle rather than reaching for the singleton, the way applyRecord does: server/utils/db.ts
 * opens the real database at module import, so a test that went through the endpoint would edit live
 * data. It lives here because the ingest paths above are exactly what it has to survive — the insert's
 * ON CONFLICT DO NOTHING and the narrow UPDATE column lists are why a re-scrape or a --rescore leaves
 * dismissed_at alone. Returns the number of rows changed.
 */
export function setDismissed(db: Database.Database, keys: string[], dismissed: boolean): number {
  if (!keys.length) return 0
  const at = dismissed ? Math.floor(Date.now() / 1000) : null // seconds, the unit secs() writes
  return db.prepare(
    `UPDATE posts SET dismissed_at = ? WHERE key IN (${keys.map(() => '?').join(',')})`
  ).run(at, ...keys).changes
}

/**
 * Marks posts applied (or un-applies them) — the owner's record of an application they sent by hand,
 * through a link or a phone number, because no draft can reach a post with no email address.
 *
 * Deliberately the same shape as setDismissed rather than a third `applications` verdict. A verdict
 * would be read by the follow-up sweep, which finds unmentioned roles by the absence of a
 * `named in ...` reason, as a role still owed an email. Returns the number of rows changed.
 */
export function setApplied(db: Database.Database, keys: string[], applied: boolean): number {
  if (!keys.length) return 0
  const at = applied ? Math.floor(Date.now() / 1000) : null // seconds, the unit secs() writes
  return db.prepare(
    `UPDATE posts SET applied_at = ? WHERE key IN (${keys.map(() => '?').join(',')})`
  ).run(at, ...keys).changes
}
