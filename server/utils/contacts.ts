// The one place a Gmail verdict becomes a `contacts` row.
//
// Its own file, rather than a function inside sync.ts, because sync.ts cannot be imported by a test: it
// reaches the drafter, Gmail and the CV modules, and one of those imports is extensionless. The same
// reasoning put pasteOnce() in paste.ts. Everything here is a plain SQLite write over an injected handle,
// so test/heal.test.ts runs it against a real migrated database.
import type Database from 'better-sqlite3'
import type { DraftPost } from './drafter.ts'
import { cachedStage, type Decision } from './stages.ts'

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
  // the same rule as the sweep: a follow-up that is due is not one that exists
  const { stage, note } = cachedStage(d)
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
    stage,
    note,
    lastSent: d.followUpDueAt ? Math.floor((d.followUpDueAt - 72 * 3600e3) / 1000) : null,
    now: Math.floor(now / 1000)
  })
}

/**
 * SQL: this post's recruiter — its first address, the one the drafter groups by — has no `contacts` row,
 * so nothing has ever been written to them. The Unprocessed half of the Posts view and the To review KPI
 * both carry it, and must agree, or the headline number disagrees with the list under it.
 *
 * NOT EXISTS, never `NOT IN (SELECT email FROM contacts)`: a post with no address extracts NULL, and a NOT
 * IN over NULL is NULL, which would drop every link-only and phone-only post from the list meant to show
 * them. A parameter for the alias because posts.get.ts builds its query unaliased and stats.get.ts as `p`.
 */
export const neverWrittenTo = (posts: string): string =>
  `NOT EXISTS (SELECT 1 FROM contacts c WHERE c.email = json_extract(${posts}.emails, '$[0]'))`

/**
 * The posts a follow-up to this recruiter carries: the roles their SENT application named (`named: true`,
 * the follow-up's subject) and any hiring post from them no email has mentioned yet.
 *
 * "Sent", not "drafted". A `named in application` row is written when the draft is created, so an
 * application the owner deleted unsent still leaves its rows — and a follow-up built on those would tell
 * the recruiter the owner applied for a role they never applied for. Rows written together share one
 * `gmail_draft_id`, so the application that actually went out is the latest one drafted at or before the
 * sent message Gmail reports (`sentAt`, the row-6 message); only that one's roles count. A role the
 * owner deletes from a draft by hand before sending is still named — the sent body is never read.
 *
 * It used to be the second half only, and bailed when that was empty — which it is for every recruiter
 * who posted one role. Measured 2026-09-25: 66 of 79 due follow-ups ended "leaving it to you".
 *
 * A named post counts only when named in an application TO THIS ADDRESS: `emails` is matched at any
 * index, so a post can reach here because this address was only its Cc. `named in follow-up` rows are out —
 * that role has had its second email. Dismissed, hand-applied and `excluded` posts stay out: the owner has
 * already said what they want done with them, and the exclude list is a promise the batch queue keeps too.
 */
export function followUpPosts(db: Database.Database, email: string, sentAt: number): DraftPost[] {
  const rows = db.prepare(`
    WITH sent AS (
      SELECT gmail_draft_id FROM applications
      WHERE recruiter_email = @email AND reason LIKE 'named in application%' AND created_at <= @sentAt
      ORDER BY created_at DESC LIMIT 1
    )
    SELECT p.*, (a.reason LIKE 'named in application%') AS named
    FROM posts p LEFT JOIN applications a ON a.key = p.key
    WHERE EXISTS (SELECT 1 FROM json_each(p.emails) WHERE value = @email)
      AND coalesce(p.post_type, 'hiring') = 'hiring'
      AND (a.key IS NULL
        OR a.reason NOT LIKE 'named in %'
        OR (a.reason LIKE 'named in application%' AND a.recruiter_email = @email
          AND a.gmail_draft_id = (SELECT gmail_draft_id FROM sent)))
      AND p.dismissed_at IS NULL
      AND p.applied_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(p.flags) WHERE value = 'excluded')
    ORDER BY named DESC, p.score DESC
  `).all({ email: email.toLowerCase(), sentAt: Math.ceil(sentAt / 1000) }) as Record<string, unknown>[]
  return rows.map(r => ({
    key: r.key as string,
    title: r.title as string | null,
    company: r.company as string | null,
    location: r.location as string | null,
    score: r.score as number | null,
    postType: (r.post_type as DraftPost['postType']) ?? null,
    flags: JSON.parse((r.flags as string) || '[]'),
    text: r.text as string,
    named: r.named === 1
  }))
}
