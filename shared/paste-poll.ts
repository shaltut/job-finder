// Pure matching for the paste card's polling loop (app/pages/index.vue) — kept out of the component so
// a node:test file can exercise it directly; there is no Vue/page test infrastructure in this repo, so
// this file imports none.
//
// GET /api/job's paste lane only ever exposes one finished job (`last`), never a history, and does not
// carry the local UI's notion of "which entry is this." Identity has to be derived, and matching by
// position ("the oldest queued entry") was tried first and was wrong on two ordinary flows: pasting a
// second post before the first resolves (the card's own footer invites this), and pressing "Paste
// again" after a failure, which resubmits the identical text under a new local entry. Matching on the
// pasted text (the server's own dedup key for an in-flight paste) plus the finished job's `endedAt`
// landing after the entry was created is what tells a genuine completion from a stale one apart.

/** ponytail: a single global slot for the paste lane's `last`, and no per-job id in the API response —
 * two jobs finishing inside one ~2s poll tick makes the earlier one unrecoverable rather than
 * misattributed (findFinishedMatch below simply returns no match for it). Fix needs the server to
 * expose a job id or a short history; out of scope for a UI-only change. */

// Ten queued pastes is a real ceiling, not a round number: ten sequential runs of one lane, each
// budgeted generously at 30s (a paste job is one gpt-5-nano Responses call with a strict JSON schema,
// not a multi-tool `claude -p` session, so a single one should resolve in seconds) gives 5 minutes for
// the tenth entry's own wait clock — measured from ITS OWN submission time, so it has to survive nine
// other jobs finishing first, plus its own. Raise this if a slower model ever replaces gpt-5-nano.
export const PASTE_STALE_MS = 5 * 60 * 1000

export interface QueuedPaste { text: string, at: number }
export interface FinishedPasteJob { log: string[], endedAt: string | null, args?: { text?: string } }

/**
 * Which queued entry, if any, the lane's most recently finished job resolves. `null` when `last` is
 * unfinished, foreign to every queued entry (its text matches none), or stale relative to the one entry
 * that shares its text — a retried paste creates a new entry whose `at` is after the failed attempt's
 * own `endedAt`, so the old job can never re-match it.
 */
export function findFinishedMatch<T extends QueuedPaste>(queued: T[], last: FinishedPasteJob | null): T | null {
  if (!last?.endedAt) return null
  const endedAt = Date.parse(last.endedAt)
  return queued.find(p => p.text === last.args?.text && p.at < endedAt) ?? null
}

/** Entries that have been 'queued' longer than the lane could plausibly still be working on them. */
export function stalePastes<T extends QueuedPaste>(queued: T[], now: number, boundMs = PASTE_STALE_MS): T[] {
  return queued.filter(p => now - p.at > boundMs)
}
