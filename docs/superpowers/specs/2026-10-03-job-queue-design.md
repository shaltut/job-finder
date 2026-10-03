# Job queue: durable, prioritised, parallel, retried — design

**Date:** 2026-10-03 · **Status:** approved in chat

## Problem (from `server/utils/jobs.ts` as of 95c376a)

1. **The queue is in memory only** (`globalThis.__jobfinderRunner`). A Nitro worker rebuild — any server
   file edit — or a restart drops it: measured 2026-10-01, one edit lost a running draft and 18 queued.
   It also never travels with the cross-machine hand-off.
2. **The draft lane is shared by draft, sync and gaps, FIFO.** A full gaps backfill (hours, OpenAI) blocks
   every Draft press and the Gmail sync; one hand-picked Draft waits behind a 20-post bulk run.
3. **One recruiter at a time** inside a draft job (~20-60 s each).
4. **No retry**: a recruiter that times out or breaks the contract waits for the next run the owner starts.

## Design

### 1. Durable queue

- New table `job_queue (id INTEGER PRIMARY KEY, lane TEXT, kind TEXT, args TEXT /* JSON */,
  queued_at TEXT, started_at TEXT /* null while waiting */)`. Drizzle schema + generated migration.
- `enqueue()` inserts; `runJob()` sets `started_at`; `finish()` deletes the row. Cancelling a queued item
  deletes it. Writes go through the server connection (`sqlite` from `db.ts`) — the server stays the
  sole writer; the job runners' own connections are untouched.
- **Restore at boot** — a Nitro plugin ordered after `migrate.ts` (`server/plugins/queue.ts`):
  - rows with `started_at` set were cut off mid-run. `draft`, `sync`, `gaps`, `paste` go back to the
    **front** of their lane (`started_at` cleared) with a log line; scrape-lane kinds (`scrape`, `rescore`,
    `reflag`, `reextract`) are **deleted** and logged "interrupted — press Start again" — re-running a
    scrape on every server edit would spend the LinkedIn rate limit.
  - `state.seq` = max(id) so new ids never collide with restored ones.
  - Only when the in-memory state is empty (a fresh worker), so a module-level HMR re-run inside one
    worker cannot double the queue.
- Re-running an interrupted draft is safe: drafted posts are out of the batch query (`a.key IS NULL`), and
  `closedInGmail()` refuses a recruiter with a pending draft (row 4).
- The table rides in the hand-off snapshot, so queued work moves to the other machine.

### 2. Lanes and priority

- A fourth lane, **`gaps`** (`kind: 'gaps'` only). It uses OpenAI, not `claude`, and shares no recruiter
  state with drafting. Touches the seven places CLAUDE.md lists plus `app/types` `Lane` and the lane seeds
  in `run.vue` / `pipeline.vue`; `state.lanes.gaps ??=` for a worker already running.
- **`sync` stays on the draft lane**: concurrent with drafting it could write an application and a
  follow-up to the same recruiter at once.
- `pump()` picks the draft lane's next item by priority, then FIFO:
  0. hand-picked drafts — `key`, or `keys` without `screened`;
  1. `sync`;
  2. everything else (screened bulk `keys`, batch `{ n }`).
  The existing single-key coalescing still drains every waiting single-key item into the chosen one.

### 3. Parallel recruiters

- `runDraftJob` processes recruiter groups through a small pool: `JOBFINDER_DRAFT_CONCURRENCY`, default 2,
  clamped 1-4. Each group already has its own `claude` session, Gmail gate and `persist()` transaction;
  `better-sqlite3` is synchronous, so writes never interleave mid-transaction.
- The CV renderer is shared and opens a page per render on one browser — safe for 2-4 concurrent renders.
- Log lines stay prefixed with the recruiter address (they already are), so interleaving stays readable.
- Stop: the shared `AbortSignal` already reaches every `runDrafter`; the pool stops taking new groups.

### 4. One retry per recruiter

- Around `runDrafter` only — never around `createDraft` (a retry there could create a duplicate Gmail
  draft). On any error except an abort: wait 10 s, log `<email>: retry 1/1: <reason>`, try once more.
  A contract rejection is retried too: the model is not deterministic and a second answer often passes.
- The Gmail gate (`closedInGmail`) is not retried — a network failure there already leaves the posts
  unprocessed for the next run, which is the right posture for a check.

## Tests

- `test/queue.test.ts` over pure helpers extracted from `jobs.ts` (which no test can import):
  `draftPriority(item)`, `pickNext(queue, lane)`, `restorePlan(rows)` (requeue vs drop, ordering, seq),
  `pool(items, n, fn)` (never more than n in flight, all complete, stops on abort),
  `withRetry(fn, { signal, wait })` (one retry, no retry on abort).
- A live check: queue two drafts, edit a server file, confirm they come back after the rebuild.
