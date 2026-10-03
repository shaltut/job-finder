# Location indicator + job queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (A) a standardized Location cell on the Posts view; (B) a job queue that survives restarts, prioritises hand-picked drafts, drafts recruiters in parallel and retries once.

**Architecture:** (A) pure `shared/place.ts` over an improved `countriesIn()`, computed per row in `posts.get.ts`, rendered by the Posts grid. (B) pure queue helpers in `server/utils/queue-core.ts` (testable — `jobs.ts` is not importable from tests), wired into `jobs.ts`, a `job_queue` table restored by a Nitro plugin, a fourth `gaps` lane.

**Tech Stack:** Nuxt 4 / Nitro, Nuxt UI v4, better-sqlite3 + Drizzle, `node --test`.

**Specs:** `docs/superpowers/specs/2026-10-03-location-indicator-design.md`, `docs/superpowers/specs/2026-10-03-job-queue-design.md`

## Global Constraints

- City, region and Arabic-name tables are **filter/display only**: never reach `withAliases()`, `nameFormsFor()` or any prompt. (Ruling: the spec's "Arabic names as aliases" would have put them in the scoring prompt via `withAliases()`; they go in a separate table instead.)
- No email-TLD / phone-code inference in the location answer.
- **Before any edit under `server/`** (or a `shared/`/`scraper/` file the server imports): `curl -s http://127.0.0.1:3939/api/job` shows no current job and an empty queue.
- Backslashes in source: avoid literal `\` in regexes written through shell heredocs; verify bytes after edits.
- Scrape-lane jobs are never auto-resumed after a restart.
- A retry wraps `runDrafter` only — never `createDraft`.
- `JOBFINDER_DRAFT_CONCURRENCY` default 2, clamped 1-4.

## Review Focus

1. "Atlanta, Georgia" vs "Tbilisi, Georgia" — country must differ. Pinned in L1.
2. A body that says "hybrid" while the location says "Remote" — location wins. Pinned in L2.
3. Restart while a bulk draft is running and two single drafts are queued — single drafts first after restore, the bulk job back at the front of the draft lane but behind priority 0. Pinned in Q1 (`restorePlan` + `pickNext`).
4. Two recruiters in parallel both rendering a tailored CV — renderer opens a page per render. Checked live in Q4.
5. Stop during a parallel run — no new group starts after abort. Pinned in Q1 (`pool`).

---

## Part A — Location

### Task L1: `countriesIn()` coverage and the Georgia fix

**Files:** Modify `shared/countries.ts`; Test `test/countries.test.ts` (append).

- [ ] Write failing tests: `countriesIn('Atlanta, Georgia')` → `['USA']`; `'Tbilisi, Georgia'` → `['Georgia']`; `'Austin, Texas'` → `['USA']`; `'Toronto, ON'` → `['Canada']`; `'Jaipur'` / `'Vadodara, Gujarat'` / `'Coimbatore'` → `['India']`; `'Ikeja, Lagos'` → `['Nigeria']`; `'المنطقة الشرقية، المملكة العربية السعودية'` → `['Saudi Arabia']`; and `withAliases(['Saudi Arabia'])` unchanged (no Arabic). Run: `node --test test/countries.test.ts` → FAIL.
- [ ] Implement: `US_STATE_NAMES` (50 + DC, lower-case), `CA_PROVINCES` codes, more `CITY_COUNTRY` entries (measured misses), `ARABIC_COUNTRY` map (filter-only). In `countriesIn`: a segment that is a US state code or full name adds USA; when USA came from a state segment and no Georgia-specific city (tbilisi, batumi) appears, drop Georgia. Province code segment adds Canada.
- [ ] Run tests → PASS; `npm test` green. Print before/after resolution (all hiring; score ≥ 6) with the scratch script and record both numbers in the commit message.
- [ ] Commit.

### Task L2: `shared/place.ts`

**Files:** Create `shared/place.ts`; Test `test/place.test.ts`.

**Produces:** `interface Place { countries: { name: string, flag: string }[], city: string | null, region: string | null, mode: 'remote' | 'hybrid' | 'onsite' | null, modeFromText: boolean, stated: boolean }` and `placeOf(location, body, remoteFlag): Place`; `flagOf(code)`.

- [ ] Failing tests: `placeOf('Riyadh, Saudi Arabia', '', false)` → SA flag, city Riyadh, mode null; `('Remote (India)', '', true)` → India, mode remote; `('remote', '', true)` → no country, mode remote, stated true; `('unknown', 'We work hybrid 3 days', false)` → stated false, mode hybrid, modeFromText true; `('Remote', 'hybrid allowed', true)` → mode remote, modeFromText false; `('Bangalore', '', false)` → city 'Bengaluru'; `('Middle East', '', false)` → region 'Middle East'.
- [ ] Implement (pure, no node imports). Work-mode words matched with a char-class boundary helper (no `\b` literals). Body detection hybrid/on-site only.
- [ ] Tests PASS; commit.

### Task L3: API + Location column

**Files:** Modify `server/api/posts.get.ts` (add `place`), `app/types/index.d.ts` (`place: Place` on the row type, imported from `~~/shared/place`), `app/pages/index.vue` (Where → Location cell; subtitle keeps company only).

- [ ] Check jobs idle. Add `place: placeOf(r.location, r.text, r.remote)` to each returned row (the query already selects text? if not, select it — measured row count ≤ 100).
- [ ] Cell per spec: line 1 flag + country / "+N" with `title`, "🌐 Remote · anywhere", "🌍 <region>", "❔ Not stated"; line 2 city · mode chip ("Remote (India only)" when remote with a country; "(from post text)" suffix); keep *in scope* chip.
- [ ] `npm run typecheck`, `npm run lint`, screenshot at 1280 and 1920; commit.

## Part B — Queue

### Task Q1: pure queue helpers

**Files:** Create `server/utils/queue-core.ts`; Test `test/queue.test.ts`.

**Produces:**
```ts
export type Lane = 'scrape' | 'draft' | 'paste' | 'gaps'
export interface QItem { id: number, lane: Lane, kind: string, args: { key?: string, keys?: string[], screened?: boolean }, queuedAt: string }
export function draftPriority(i: QItem): 0 | 1 | 2
export function pickNext(queue: QItem[], lane: Lane): number            // index or -1
export function restorePlan(rows: { id: number, lane: Lane, kind: string, started: boolean }[]): { requeueFront: number[], drop: number[], seq: number }
export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, signal?: AbortSignal): Promise<void>
export async function withRetry<T>(fn: () => Promise<T>, o: { signal?: AbortSignal, waitMs?: number, onRetry?: (e: Error) => void }): Promise<T>
export function concurrency(env?: string): number                        // default 2, clamp 1-4
```
- [ ] Failing tests for each (priority order + FIFO tie; restore drops scrape-lane started rows, requeues others at front in original order, seq = max id; pool never exceeds n in flight, completes all, stops starting after abort; withRetry retries once, not on AbortError, rethrows second failure; concurrency parsing).
- [ ] Implement; PASS; commit.

### Task Q2: durable queue + restore

**Files:** Modify `server/db/schema.ts` (table `job_queue`), generate migration (`npm run db:generate`), `server/utils/jobs.ts` (insert on enqueue, mark started in runJob, delete on finish/cancel), Create `server/plugins/queue.ts` (`restoreQueue()` after migrate).
- [ ] Jobs idle. Schema + migration; boot migrates.
- [ ] Persist + restore using `restorePlan`; `state.seq` from plan; restore only when memory queue and lanes are empty.
- [ ] Live check: queue two single drafts behind a running one, touch a server file, `curl /api/job` shows them restored. Commit.

### Task Q3: gaps lane + priority

**Files:** `server/utils/jobs.ts` (Lane union via queue-core, state init + `??=`, laneOf, busy, runJob dispatch branch for gaps, stateView, pump uses `pickNext`), `app/types/index.d.ts` (`Lane`), `app/pages/run.vue` + `pipeline.vue` lane seeds (+ run.vue shows the gaps lane if it renders lanes by name).
- [ ] Implement; typecheck; live: start Extract gaps and press Draft on one post — both run at once. Commit.

### Task Q4: parallel recruiters + retry

**Files:** `server/utils/jobs.ts` `runDraftJob` (loop → `pool(groups, concurrency(env), …)`; `runDrafter` wrapped in `withRetry` with `onRetry` logging `<email>: retry 1/1: <reason>`).
- [ ] Implement; `npm test`; live: a bulk draft of ≥ 3 recruiters logs two in flight. Commit.

### Task Q5: docs

**Files:** `CLAUDE.md` (Three lanes → four; durable queue; priorities; concurrency env; retry), `.env.example` (`JOBFINDER_DRAFT_CONCURRENCY`).
- [ ] Commit.
