// Its own file because jobs.ts cannot be imported by a test (it reaches the drafter, Gmail and the CV
// modules) — the same reason contacts.ts and paste-job.ts exist.
import type Database from 'better-sqlite3'

/**
 * The rows a keyed draft request may touch. Dismissed and applied posts are out in both modes: the
 * Posts view hides Draft on them, but a tab left open beforehand must not email about them.
 * `screened` (bulk Draft) takes the batch queue's whole predicate (jobs.ts, the `{ n }` query):
 * - `a.key IS NULL`: a screened run may record a skip, and persist() would otherwise rewrite an existing
 *   `drafted` verdict — and its `named in` prefix the follow-up depends on — as `skipped`;
 * - no flags: the exclude list is a promise the batch queue keeps, and a selection made under
 *   Flags: Excluded (or before a reflag landed) must keep it too;
 * - hiring, score 6+, an address: what "screened like the batch run" tells the owner it means.
 * The hand-picked path (the row's Draft button) takes none of these — that is the owner overruling.
 */
export function keyedDraftRows(db: Database.Database, keys: string[], screened: boolean): unknown[] {
  return db.prepare(`
    SELECT p.* FROM posts p ${screened ? 'LEFT JOIN applications a ON a.key = p.key' : ''}
    WHERE p.key IN (SELECT value FROM json_each(?))
      AND p.dismissed_at IS NULL AND p.applied_at IS NULL
      ${screened
        ? `AND a.key IS NULL
           AND json_array_length(p.emails) > 0
           AND coalesce(p.post_type, 'hiring') = 'hiring'
           AND json_array_length(p.flags) = 0
           AND p.score >= 6`
        : ''}
  `).all(JSON.stringify(keys))
}

/** Keys not already waiting in the queue (as a single `key` or inside a bulk `keys`) or running now. */
export function freshKeys(keys: string[], queued: { key?: string, keys?: string[] }[], running: string[]): string[] {
  const taken = new Set([...running, ...queued.flatMap(q => [q.key, ...(q.keys ?? [])]).filter(Boolean) as string[]])
  return keys.filter(k => !taken.has(k))
}
