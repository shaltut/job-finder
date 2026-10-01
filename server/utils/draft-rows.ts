// Its own file because jobs.ts cannot be imported by a test (it reaches the drafter, Gmail and the CV
// modules) — the same reason contacts.ts and paste-job.ts exist.
import type Database from 'better-sqlite3'

/**
 * The rows a keyed draft request may touch. Dismissed and applied posts are out in both modes: the
 * Posts view hides Draft on them, but a tab left open beforehand must not email about them.
 * `screened` (bulk Draft) adds the batch queue's `a.key IS NULL`: a screened run may record a skip,
 * and persist() would otherwise rewrite an existing `drafted` verdict — and its `named in` prefix the
 * follow-up depends on — as `skipped`.
 */
export function keyedDraftRows(db: Database.Database, keys: string[], screened: boolean): unknown[] {
  return db.prepare(`
    SELECT p.* FROM posts p ${screened ? 'LEFT JOIN applications a ON a.key = p.key' : ''}
    WHERE p.key IN (SELECT value FROM json_each(?))
      AND p.dismissed_at IS NULL AND p.applied_at IS NULL
      ${screened ? 'AND a.key IS NULL' : ''}
  `).all(JSON.stringify(keys))
}

/** Keys not already waiting in the queue (as a single `key` or inside a bulk `keys`) or running now. */
export function freshKeys(keys: string[], queued: { key?: string, keys?: string[] }[], running: string[]): string[] {
  const taken = new Set([...running, ...queued.flatMap(q => [q.key, ...(q.keys ?? [])]).filter(Boolean) as string[]])
  return keys.filter(k => !taken.has(k))
}
