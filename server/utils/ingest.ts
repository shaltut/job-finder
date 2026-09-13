// The single place scraper output becomes database rows. Used by the Nitro server (which spawns the
// scraper from the UI) and by scraper/ingest.ts (the CLI pipe), so both paths behave identically.
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

export type ScraperRecord
  = | ({ op: 'post' } & PostRecord)
    | { op: 'update', key: string, postType: PostType | null, title: string, company: string, location: string, remote: boolean, inScope: boolean, score: number, reason: string }
    | { op: 'reflag', key: string, flags: string[], postedAt: string | null }
    | { op: 'posturl', key: string, postUrl: string }
    | { op: 'done', added: number }

/** Who is posting. Only 'hiring' is a job; null means a row scored before the column existed. */
export type PostType = 'hiring' | 'seeking' | 'other'

export interface PostRecord {
  key: string
  searchTerm: string
  author: string
  authorUrl: string
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
                         title, company, location, remote, in_scope, emails, score, reason, text, flags)
      VALUES (@key, @searchTerm, @author, @authorUrl, @postUrl, @postedAge, @postedAt, @postType,
              @title, @company, @location, @remote, @inScope, @emails, @score, @reason, @text, @flags)
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

  if (rec.op === 'posturl') { // a known post seen again, whose row predates permalinks or came from the feed
    const r = db.prepare(`UPDATE posts SET post_url = @postUrl WHERE key = @key AND post_url IS NULL`)
      .run({ key: rec.key, postUrl: rec.postUrl })
    return r.changes ? 'update' : null // never overwrites a URL already stored
  }

  return null // 'done' carries a count for the caller to report, not a row
}
