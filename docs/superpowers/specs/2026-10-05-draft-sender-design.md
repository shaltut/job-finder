# Draft sender lane — design

**Date:** 2026-10-05 · **Status:** approved in chat (owner chose: every app-created draft, edited ones included)

## Problem

Drafts pile up in Gmail and the owner sends each by hand. They want a lane they start by hand that sends
10 random app drafts every 15 minutes until none are left.

## The rule this changes

Until now **nothing could send** (CLAUDE.md, Gmail section; `test/invariants.test.ts`). It becomes **one
file can send**: `server/utils/sender.ts`, and only drafts this app created, each re-checked just before.
The invariant test pins that single call site. The owner chose no review step, so the pre-send checks are
the only backstop.

## Design

### `app_drafts` — which drafts are the app's

`draft_id` (PK), `email`, `mode` (`apply` | `follow-up`), `created_at`, `sent_at`, `outcome`. Written by
`persist()` in `server/utils/drafts.ts` whenever it records a Gmail draft (a ref that is not a local
`.json` file) — both draft paths pass through it. Backfill at migration: every distinct
`applications.gmail_draft_id` that is not a file path, mode `apply`. Follow-up drafts created before this
table cannot be identified (their id lived only in a note the sweep overwrites) — the owner sends those.
Personal drafts in the owner's Gmail are never in this table and never sent.

### The `send` lane

A fifth lane, `send`, so hours of waiting never hold the draft lane. Started from the Run view
(**Send drafts**, `POST /api/run/send`); Stop ends it immediately (the 15-minute wait is abortable).
A round:
1. Unsent rows (`sent_at IS NULL AND outcome IS NULL`), shuffled, first 10 (`pickBatch`).
2. Per draft, one at a time: `drafts.get` (full). 404 → `outcome = 'gone'` (deleted or sent by hand).
3. `sendable()` — refuse with a reason, recorded as `outcome`, never retried:
   - a placeholder in subject or body (`PLACEHOLDER` from `drafter.ts`);
   - no PDF attached (every app draft carries the CV);
   - the recruiter's Gmail no longer says "draft pending": `decideStage()` over their real mail must be
     row 7 (`send-the-application`) or row 4 (`send-the-follow-up`). A reply, a bounce, an email already
     sent — anything else — is a skip.
4. `POST drafts/send` → `sent_at = now`.
5. After the round, `enqueue('sync')` so stages and follow-up clocks move.
6. Wait 15 minutes; repeat until no unsent row remains → "all sent".

An interrupted send job resumes (durable queue); a sent draft is recorded first-hand, so nothing is sent
twice. A send failure that is not a 404 leaves the row unsent for the next round.

### Pure parts (`server/utils/sender-core.ts`, testable)

`pickBatch(ids, n, random)`, `sendable({ subject, body, hasPdf, action })`, `draftText(gmailMessage)`
(subject, decoded text/plain body, PDF present).

## Not doing

No per-draft review UI, no scheduling by time of day, no rate faster than 10 per 15 minutes.

## Verification

Unit tests for the pure parts and the invariant. Live: the owner starts one round and stops it after the
first batch; the log lists each draft sent or skipped with its reason, and the Pipeline moves those
recruiters to `contacted` after the sync.
