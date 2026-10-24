# Both machines running — a lease, not a merge

**Date:** 2026-10-24 · **Builds on:** `2026-10-03-cross-machine-sync-design.md`

## Problem

The owner: "can the sync happen while both are running? To switch I have to stop one and start the
other, and sometimes I forget the other one is still running."

What happened when both ran, read from the code before this change:

- The first push wins the `gen` compare-and-swap. The other machine's next push fails `canPush`, writes
  `backups/conflict-*.db`, and sets a **sticky** `conflict`: it never pushes again until restarted, and
  everything it does from then on is only in that backup (recoverable by hand with `scripts/merge-db.ts`).
- The conflicted machine also **stopped heartbeating** (`beat()` skipped on conflict), and a machine with
  changes to push never heartbeated at all: the plugin ran `pushNow()` *or* `beat()`, and `push()` writes no
  heartbeat. So the busy machine — the one that mattered — always looked idle, and the "other machine looks
  active" warning sat on the Run view only.
- Both machines kept running the inbox poll, the daily sweep and any lane. The Gmail checks do **not**
  make that safe: `closedInGmail` can read row 8 on both machines inside Gmail's index lag and draft two
  applications, and `sendable()`'s local record (`app_drafts` sent rows) is per machine, so a second
  application can go out before the first is searchable. Both polls would draft a reply in the same thread.

## Rejected: merge both databases continuously

A per-table merge (insert-or-ignore plus monotone rules: `contacts.stage` by rank with `final`/`replied`
sticky, `drafted` beats `skipped`, a non-null `dismissed_at` wins) converges the rows, but not the
behaviour: two writers still double-draft and double-send inside Gmail's lag, `settings` has no
timestamp to pick a winner, `flags` are derived from each side's settings, un-dismissing is
inexpressible, and a merged `inbox` row left `queued` is re-enqueued by `strandedQueued` on the other
machine. Every hole is the same fact — two machines cannot both be writers — so the design makes that
the rule instead of patching each symptom.

## Design: one leader, one standby

Both machines run. Exactly one **leads**: it runs jobs, takes writes and pushes. The other is on
**standby**: it pulls each newer snapshot into its live database and runs nothing. Switching is one
button, **Use this machine**, on the standby.

- **The lease lives in the per-host heartbeat files** (`heartbeat-<host>.json`: `at, host, role, since,
  gen`), written every 30 s in every role. Per host because a shared file becomes a sync-client conflict
  copy. A heartbeat over 5 minutes old is no peer.
- **Boot:** a fresh process stands by when the other machine's heartbeat says it leads or is taking over
  (`bootRole`). That alone ends "I forgot the PC was running": the forgotten machine keeps leading, the
  new one comes up harmless and says so. The boot pull (file swap) is unchanged.
- **Every 30 s, `nextStep()`** (pure, in `server/utils/handoff.ts`):
  - **active** → **yielding** when the peer claims, when the peer also leads and became leader later (a
    laptop that slept through a take-over), or when a newer gen than ours appeared. The leader never
    pulls under its own running jobs; it yields first.
  - **yielding** stops every lane and drops the queue (`yieldAll`), waits until nothing runs, pushes its
    last changes, then stands by.
  - **standby** follows each newer snapshot and **never leads on its own**: a stale peer heartbeat looks
    the same whether the other machine closed or this machine's OneDrive stopped delivering, and leading
    in the second case pushes into a stale folder — a sync-client stray that stops both machines. After
    closing the leader, press the button on the other machine (it leads at once).
  - **claiming** waits until the peer reads `standby` and its final snapshot has arrived
    (`remoteGen >= peer.gen`), then pulls and leads. With no live peer it leads at once.
  - Ties go to the lower host name.
- **Live pull (`livePull`):** the file cannot be swapped under the connection every module holds, so the
  snapshot is ATTACHed and every table's rows are replaced in one transaction — all deletes before all
  inserts (applications and post_requirements cascade from posts), foreign keys deferred to commit,
  shared columns only. **`job_queue` is never copied.** Safe only because standby runs nothing.
- **What enforces "standby runs nothing":** `pump()` starts nothing and `enqueue()` queues nothing unless
  leading; the inbox, daily and schedule tasks skip; `restoreQueue` does not resume on standby; and the origin
  middleware refuses every non-GET `/api/` call but `/api/sync/*` with 409.
- **The conflict is no longer sticky.** A refused push still writes `backups/conflict-*.db`; the next tick
  yields and the standby pull clears it. A live pull also clears a failed boot pull's push block.

### Per-table outcome

Whole-snapshot replace, from the leader: no row-level merge, because only one machine writes. The
`contacts`, `applications`, `posts`, `settings`, `app_drafts`, `inbox` and `post_requirements` invariants
hold because they hold on the leader. `job_queue` stays per machine. Work a standby could not publish is
kept in `backups/pre-pull-*.db` (a pull over unpushed changes takes that copy first).

## Ceilings

- `ponytail:` the lease travels through OneDrive, so a take-over waits on its delivery — about a minute
  or two. A claim on a peer whose heartbeat is over 5 minutes old (asleep, offline) proceeds at once; if
  that peer was only paused it also leads until its next tick reads the newer leader. That window, up to ~30 s plus
  delivery, is the one place two machines can both run jobs. A real lock needs a server both can reach.
- Standby is read-only: dismissing or pasting there needs the button first.
- A build from before this change writes a heartbeat with no role; it reads as leading and never yields,
  so a claim against it never completes while it runs. **Upgrade: stop both, update both, start.**

## Tests

`test/handoff.test.ts`: every `nextStep` transition and tie, `bootRole`, an old-format heartbeat,
`standbyRefuses`, a full take-over over two temp machines with B's connection open throughout (rows
replaced, B's `job_queue` kept), and a half-delivered snapshot refused with the live rows untouched.
`test/queue.test.ts`: no restore on standby.
