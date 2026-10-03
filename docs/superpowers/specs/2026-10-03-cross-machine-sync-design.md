# Cross-machine sync — design

**Date:** 2026-10-03 · **Status:** approved in chat, awaiting spec review

## Problem

The app runs on two machines — a Windows 11 PC and a Mac — each with its own `data/jobfinder.db`, so the
records split: a scrape on one machine is invisible to drafting on the other. The owner alternates
machines (a week here, a week there; or scrape on one, then draft and send on the other).

## Constraints (stated by the owner)

- **The two machines never run the app at the same time.** This is what makes a file hand-off sufficient
  and a shared live database unnecessary.
- The same OneDrive account is signed in on both.
- One machine is a Mac, so nothing shared may carry a Windows path.

## Rejected

- **`data/` inside OneDrive.** The database runs in WAL mode; a file sync copies the main file while
  commits still sit in `-wal` — the same failure that cost the old file-copy backup 12 posts on
  2026-09-25 — and produces conflict copies or a torn file.
- **Hosted database (Turso / Postgres).** Every query in the app is synchronous `better-sqlite3`; going
  async is days of work, and only needed for concurrent use, which the owner ruled out.

## Design

### Layout

- Live database stays local and unchanged: `data/jobfinder.db`.
- `.env` → `JOBFINDER_SYNC_DIR` names the shared folder:
  - Windows: `C:\Users\<user>\OneDrive\job-finder-sync`
  - Mac: `~/Library/CloudStorage/OneDrive-Personal/job-finder-sync`
- The shared folder holds:
  - `jobfinder.db` — the latest snapshot
  - `cv/` — a mirror of `data/cv/` (uploaded PDF, `master.json`, `tailored/`)
  - `sync.json` — `{ gen, host, pushedAt, heartbeatAt }`
- Per machine, `data/sync-state.json` — `{ gen }`, the generation this machine last pushed or pulled.
- **Unset `JOBFINDER_SYNC_DIR` = sync off**: no timer, no boot pull, no button effect. A fresh clone or a
  single-machine install behaves exactly as today.

### Pull — at boot, before the database opens

`server/utils/db.ts` opens the database on import, so the pull runs before that import is evaluated:
a Nitro plugin ordered first (or the pull called at the top of `db.ts`'s `open()`), never after a
connection exists.

1. Read `sync.json`. Missing → nothing to pull (first machine to sync; its first push seeds the folder).
2. If `remote.gen > local.gen`:
   1. If a local database exists, `VACUUM INTO backups/pre-pull-<date>-<time>.db`.
   2. Copy the snapshot to `data/jobfinder.db.tmp`, verify it opens and `PRAGMA integrity_check` is `ok`,
      delete the local `-wal` / `-shm`, rename the tmp over `data/jobfinder.db`.
   3. Mirror `cv/` → `data/cv/` (copy a file when missing locally or a different size/mtime; never delete).
   4. Write `local.gen = remote.gen`.
3. A failed pull (snapshot unreadable, integrity check fails, OneDrive placeholder not downloadable)
   **keeps the local database**, logs why, and **disables pushing for this session** — pushing from a
   machine that could not see the latest snapshot is how the newer one gets overwritten.

### Push — automatic, plus a button

- Every 2 minutes, if the server connection's `total_changes()` moved since the last push (or the
  `data/cv/` mirror has new files), push. Also on **Sync now** in the Run view (`POST /api/sync/push`).
- Push = compare-and-swap on `gen`:
  1. Re-read `sync.json`. If `remote.gen !== local.gen`, **another machine pushed since this one pulled**
     → do not push; set a sticky `conflict` state the UI shows as a banner ("another machine's data
     arrived — restart to pull it; work done here since is in backups/"). Before stopping, take one
     `VACUUM INTO backups/conflict-<date>-<time>.db` so that work is recoverable.
  2. `VACUUM INTO <sync>/jobfinder.db.tmp`, rename over `<sync>/jobfinder.db`.
  3. Mirror `data/cv/` → `<sync>/cv/` (same copy rule, never delete).
  4. Write `sync.json` with `gen + 1`, this host, now; then `local.gen = gen + 1`.
- Pushing during a running job is safe: `VACUUM INTO` reads a consistent snapshot through WAL, as the
  daily backup already relies on. No lane check.
- **The heartbeat**: each push and each 2-minute tick writes `heartbeatAt`. At boot, a `host` other than
  this one with `heartbeatAt` under 5 minutes old shows a warning: "the other machine looks active —
  close it first." A warning, not a lock: a crashed machine must not lock the owner out.

Ceiling: the snapshot is the whole database (~8 MB today), rewritten at most every 2 minutes while
something changes. `ponytail:` fine at this size; switch to the session extension's changesets if it
grows past ~100 MB.

### Path normalisation

`contacts.cv_path` is stored as `data\cv\tailored\<slug>\<file>.pdf` on Windows. On the Mac `\` is a
filename character, so `existsSync` fails and `cv-attach.ts` silently falls back to the uploaded CV — the
follow-up then attaches a different CV than the application did.

- Write: `drafts.ts` stores `cv_path` with `/` (`split(sep).join('/')`, or `posix` join at the source).
- Read: `cv-attach.ts` replaces `\` with `/` before `existsSync` (Node on Windows accepts `/`).
- One-time migration: `UPDATE contacts SET cv_path = replace(cv_path, '\', '/') WHERE cv_path LIKE '%\%'`.
- `settings.cv` is already stored with `/` (verified) — no change.

### Not synced — one-time setup per machine

- `.env`, `google-oauth.json`, `gmail-token.json` — copied by hand once (secrets do not go through
  OneDrive).
- `profile/` — `npm run login` on each machine; a live browser profile does not survive file sync.
- `node_modules` — `npm install` on each machine (`better-sqlite3` is native).
- `backups/`, `logs/` — per machine.

### UI

- Run view: a **Sync** line — off / last push time and gen / conflict banner / other-machine-active
  warning — and a **Sync now** button. Status via `GET /api/sync`.

### Data egress

The OneDrive copy holds recruiter names and addresses, post text and the owner's CV. It is the owner's
own data in the owner's own account, but it is the first time any of it leaves the machine. The README /
SETUP note says so.

## Files

- `server/utils/sync.ts` exists (the Gmail sweep), so the new module is `server/utils/handoff.ts`:
  pure decision functions (`shouldPull`, `canPush`) plus the file operations.
- Boot pull wired before `db.ts` opens; push timer as a Nitro plugin.
- `server/api/sync.get.ts`, `server/api/sync/push.post.ts`.
- `server/utils/drafts.ts`, `server/utils/cv-attach.ts`, one migration for the `cv_path` rewrite.
- `app/pages/run.vue` — the Sync line and button.
- `SETUP.md` + `CLAUDE.md` — the two-machine setup and the never-concurrent rule.

## Tests

- `test/handoff.test.ts`: `shouldPull` (missing remote, equal gen, newer gen); `canPush` refuses when
  `remote.gen !== local.gen`; a round trip over two temp dirs standing in for two machines — push from A,
  pull into B, a write on B, push from B, a stale push from A refused.
- Path: a stored `data\cv\tailored\x\cv.pdf` resolves to an existing file under `/` separators.

## Verification before calling it done

A real round trip: push from Windows, start the Mac, confirm the post count and a tailored-CV follow-up
path resolve there; push from the Mac, pull on Windows.
