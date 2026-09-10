import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

export const DB_PATH = resolve(process.cwd(), process.env.JOBFINDER_DB || 'data/jobfinder.db')

/**
 * The Nitro server is the SOLE WRITER of this file. The scraper child process opens it read-only
 * and streams rows back on stdout for the server to insert, so two processes never contend for the
 * write lock. WAL still matters: it lets the scraper read while the server is mid-write.
 */
function open() {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const sqlite = new Database(DB_PATH)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  return sqlite
}

const sqlite = open()
export const db = drizzle(sqlite, { schema })

/**
 * The raw handle, for the settings row. shared/settings.ts is duck-typed against better-sqlite3 so
 * that the scraper's read-only connection satisfies the same functions; going through Drizzle here
 * would mean two different code paths for one row.
 */
export { sqlite }

/**
 * Applies migrations at startup, the way the original applied schema.sql idempotently from both
 * entry points. Falls back to pushing the schema directly when no migration folder exists yet.
 */
export function migrateDb() {
  const folder = resolve(process.cwd(), 'server/db/migrations')
  if (!existsSync(folder)) return { migrated: false, reason: 'no migrations folder' }
  migrate(db, { migrationsFolder: folder })
  return { migrated: true }
}

export { schema }
