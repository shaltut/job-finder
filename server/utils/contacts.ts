// The one place a Gmail verdict becomes a `contacts` row.
//
// Its own file, rather than a function inside sync.ts, because sync.ts cannot be imported by a test: it
// reaches the drafter, Gmail and the CV modules, and one of those imports is extensionless. The same
// reasoning put pasteOnce() in paste.ts. Everything here is a plain SQLite write over an injected handle,
// so test/heal.test.ts runs it against a real migrated database.
import type Database from 'better-sqlite3'
import type { Decision } from './stages.ts'

/**
 * Write what Gmail said about a recruiter into the local cache.
 *
 * This exists because the owner runs the app on two machines with two databases and one Gmail account.
 * A recruiter emailed from the other machine has no row here at all, and `sweep()` cannot discover them:
 * it iterates `SELECT email FROM contacts WHERE stage IN (...)`, so it only ever revisits addresses this
 * database already knows. The draft gate is the one moment this machine asks Gmail about an address it
 * has never seen — `closedInGmail()` already computes the whole Decision and then throws all of it away
 * except the refusal reason. Keeping it is the entire fix, and it costs no extra Gmail call.
 *
 * An INSERT, where the sweep's write is an UPDATE: the sweep only ever revisits rows that exist, and this
 * is specifically for the ones that do not.
 *
 * `WHERE contacts.stage <> 'final'` is the same guard the sweep carries, and it is the two-emails-ever
 * ceiling expressed in the database rather than in prose. A recruiter who has had their two emails is
 * never reopened, no matter what the other device did afterwards.
 *
 * `last_sent_at` is recovered from the due date exactly as the sweep recovers it — silence is 72 hours
 * from the last outgoing message, so the due date minus 72 hours is when that message went.
 */
export function healContact(db: Database.Database, email: string, d: Decision, now: number): void {
  db.prepare(`
    INSERT INTO contacts (email, stage, note, last_sent_at, updated_at)
    VALUES (@email, @stage, @note, @lastSent, @now)
    ON CONFLICT (email) DO UPDATE SET
      stage        = excluded.stage,
      note         = excluded.note,
      last_sent_at = excluded.last_sent_at,
      updated_at   = excluded.updated_at
    WHERE contacts.stage <> 'final'
  `).run({
    // the schema carries CHECK (email = lower(email)) and refuses anything else
    email: email.toLowerCase(),
    stage: d.stage,
    note: d.note,
    lastSent: d.followUpDueAt ? Math.floor((d.followUpDueAt - 72 * 3600e3) / 1000) : null,
    now: Math.floor(now / 1000)
  })
}
