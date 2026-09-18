# Paste-a-post Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A box in the Posts view where the owner pastes a job post that arrived by email or WhatsApp; it is
admitted or refused instantly, then scored in the background and stored as an ordinary `posts` row.

**Architecture:** The work splits by cost. Extraction and the contact-route gate are pure regex and run
synchronously in the endpoint, so a refusal is immediate. Only the OpenAI score is queued, onto a new third
job lane that runs concurrently with the scrape and draft lanes. Nothing downstream of the row changes.

**Tech Stack:** Nuxt 4 / Nitro, better-sqlite3 + Drizzle, Zod, OpenAI Responses API, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-18-paste-a-post-design.md`

## Global Constraints

- No new dependencies.
- No identity literal — the owner's name, email, phone or handles — in any tracked file. `test/identity.test.ts`
  enforces it. **Test fixtures use invented addresses such as `recruiter@example.com`**; never a real
  recruiter's address either.
- The drafter queue predicate is **not** modified. A pasted post is scored, flagged and queued exactly like a
  scraped one. No invariant test that pins that predicate may change.
- No database migration. Every column a paste leaves empty is already nullable.
- The server remains the sole writer of the database.
- Long-lived server state lives on `globalThis` (Nitro dev HMR discards module scope).
- `npm test`, `npm run lint`, `npm run typecheck` must each exit 0 before any commit. Capture exit codes by
  redirecting (`cmd > /tmp/x.log 2>&1; echo "EXIT: $?"`) — `$?` after a pipe reports the pipe's last command
  and has produced a false pass in this repo.
- `npm run typecheck` does **not** cover `scraper/`. Changes there are only as verified as their unit tests.
- Commit with explicit paths, never `git add -A`. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012of8r2FB6dRNrh4FXFaSVQ
  ```
- Do not start, stop or restart the dev server (it may be running on port 3939). Do not call Gmail, run the
  scraper, or make an OpenAI call from a test.
- Writing `\uXXXX`, `\b`, `\s` or `\d` through a file tool in this repo has three times produced the raw
  character instead of the escape text, and tests still passed. After editing any line containing one, verify
  the bytes: `LC_ALL=C grep -c $'[\x01-\x08\x0B\x0C\x0E-\x1F]' <file>` must print 0.

## File Structure

| File | Responsibility |
|---|---|
| `scraper/score.ts` **(new)** | `loadCv` and `scorePost`, lifted verbatim out of `scraper/run.ts` so the server and the scraper share one definition. |
| `server/utils/paste.ts` **(new)** | **Pure.** `pasteGate()` and `pasteRecord()`. Imports only `scraper/lib.ts`. No `openai`, no `node:fs`, no database — this is the file the tests import. |
| `server/utils/paste-job.ts` **(new)** | **Impure.** `runPasteJob()` — the cached CV system prompt, the OpenAI call, `applyRecord`. Kept apart from `paste.ts` so the pure half stays trivially importable. |
| `server/utils/jobs.ts` (modify) | Third lane: `Lane`, `Kind`, `laneOf`, lanes init, `busy()`, `stateView()`, `JobArgs.text`, one `runJob` branch. |
| `server/api/posts/paste.post.ts` **(new)** | The synchronous gate, then `enqueue('paste', { text })`. |
| `app/pages/posts.vue` (modify) | The paste card and this-session outcome list. |
| `test/paste.test.ts` **(new)** | `pasteGate`, `pasteRecord`, and source-read invariants for the lane wiring. |

**Why the pure/impure split:** no test in this repo imports `server/utils/jobs.ts` — all four that reference it
read it as source text, because it pulls in the drafter, Gmail, sync and the CV modules, and Nitro's
auto-imports are unavailable under `node --test`. Logic that must be unit-tested therefore cannot live in
`jobs.ts`, and `paste.ts` must not import `openai` if the test is to import it cheaply.

---

### Task 1: Lift the scorer into `scraper/score.ts`

A pure refactor. No behaviour changes. `scraper/run.ts` currently holds `loadCv` and `scorePost` as
module-scoped functions that close over module-level `openai`, `system`, `MODEL` and `log`. They move to their
own file and take those as parameters.

**Files:**
- Create: `scraper/score.ts`
- Modify: `scraper/run.ts` (remove the two functions and the `Score` interface; import them instead)
- Test: `test/paste.test.ts` (created here, extended by Task 2)

**Interfaces:**
- Consumes: `SCORE_SCHEMA`, `gateOnPostType` from `scraper/lib.ts` (already exported).
- Produces:
  - `export interface Score { post_type: 'hiring' | 'seeking' | 'other'; title: string; company: string; location: string; is_remote: boolean; is_in_scope: boolean; score: number; reason: string }`
  - `export async function loadCv(path: string, log?: (s: string) => void): Promise<string>`
  - `export async function scorePost(text: string, system: string): Promise<Score>`

- [ ] **Step 1: Create `scraper/score.ts`**

```ts
// The scoring calls, shared by the scraper and the server's paste lane. Kept out of scraper/lib.ts,
// which every test imports and which is deliberately free of `openai` and `node:fs`.
import fs from 'node:fs'
import { basename } from 'node:path'
import OpenAI from 'openai'
import { SCORE_SCHEMA, gateOnPostType } from './lib.ts'

const MODEL = process.env.JOBFINDER_MODEL || 'gpt-5-nano'

let openai: OpenAI | undefined

export interface Score {
  post_type: 'hiring' | 'seeking' | 'other'
  title: string
  company: string
  location: string
  is_remote: boolean
  is_in_scope: boolean
  score: number
  reason: string
}

/** The model reads the PDF itself, one call per run; no local PDF parser. */
export async function loadCv(path: string, log?: (s: string) => void): Promise<string> {
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'user', content: [
      { type: 'input_file', filename: basename(path), file_data: `data:application/pdf;base64,${fs.readFileSync(path).toString('base64')}` },
      { type: 'input_text', text: 'Return the complete plain text of this document verbatim, with no commentary.' }
    ] }]
  } as never) as { output_text: string }
  log?.(`cv: ${path} (${r.output_text.length} chars)`)
  return r.output_text
}

export async function scorePost(text: string, system: string): Promise<Score> {
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'system', content: system }, { role: 'user', content: text }],
    text: { format: { type: 'json_schema', name: 'job_post', strict: true, schema: SCORE_SCHEMA } }
  } as never) as { output_text: string }
  return gateOnPostType(JSON.parse(r.output_text) as Score)
}
```

- [ ] **Step 2: Remove the originals from `scraper/run.ts`**

Delete the `loadCv` function, the `Score` interface and the `scorePost` function, and the `let openai: OpenAI | undefined` line. Keep `let system: string`.

Add to the imports at the top of `scraper/run.ts`:

```ts
import { loadCv, scorePost, type Score } from './score.ts'
```

Update the two call sites so they pass what used to be module state. Both currently read
`system = systemPrompt(await loadCv(CV_PATH), CONFIG)`; they become:

```ts
system = systemPrompt(await loadCv(CV_PATH, log), CONFIG)
```

and every `scorePost(text)` call becomes `scorePost(text, system)`.

Then remove any now-unused imports from `scraper/run.ts` — at minimum `OpenAI`, and `basename` / `fs` if
nothing else in the file uses them. `npm run lint` in Step 4 will name any that remain.

- [ ] **Step 3: Write the import test**

Create `test/paste.test.ts`:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadCv, scorePost } from '../scraper/score.ts'

// scraper/ has no typecheck coverage, so a broken lift there fails at run time and nowhere else.
// This is cheap and catches a syntax error, a bad import path and a changed arity.
test('the scorer is importable and keeps its shape', () => {
  assert.equal(typeof loadCv, 'function')
  assert.equal(typeof scorePost, 'function')
  // 2, not 1: Node strips the type annotations, and TypeScript's `?` leaves a plain parameter behind.
  // Function.length only stops counting at the first parameter with a default value.
  assert.equal(loadCv.length, 2, 'loadCv takes (path, log?)')
  assert.equal(scorePost.length, 2, 'scorePost takes (text, system)')
})
```

- [ ] **Step 4: Run everything**

```bash
node --test test/paste.test.ts > /tmp/p.log 2>&1; echo "EXIT: $?"
npm test > /tmp/t.log 2>&1; echo "EXIT: $?"
npm run lint > /tmp/l.log 2>&1; echo "EXIT: $?"
npm run typecheck > /tmp/tc.log 2>&1; echo "EXIT: $?"
```
All four must be 0. `npm test` should report 277 (276 before this task, plus one).

- [ ] **Step 5: Prove the scraper still parses**

`npm run typecheck` does not cover `scraper/`, so run the file:

```bash
node --env-file-if-exists=.env scraper/run.ts --help > /tmp/s.log 2>&1; echo "EXIT: $?"; head -5 /tmp/s.log
```

If `--help` is not a supported flag, the process will still have **parsed and loaded every import** before
failing on the argument — which is what this checks. A `SyntaxError` or `ERR_MODULE_NOT_FOUND` in the output
is a failure; anything about unknown arguments is a pass. Do **not** run a real scrape.

- [ ] **Step 6: Commit**

```bash
git add scraper/score.ts scraper/run.ts test/paste.test.ts
git commit -m "Lift the scorer out of the scraper so the server can share it

loadCv and scorePost closed over module state in run.ts. They take it as
parameters now and live in their own file, so the paste lane can score a post
without spawning the scraper. No behaviour change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012of8r2FB6dRNrh4FXFaSVQ"
```

---

### Task 2: The pure half — `pasteGate` and `pasteRecord`

**Files:**
- Create: `server/utils/paste.ts`
- Test: `test/paste.test.ts` (extend)

**Interfaces:**
- Consumes: `extractEmails`, `extractLinks`, `extractPhones`, `extractRefIds`, `channelsOf`, `admits`,
  `dedupeKey`, `prescreen` from `scraper/lib.ts`. Note the exact signatures:
  `channelsOf(found: { emails: string[], links: string[], phones: string[] }, text: string)`,
  `admits(channels, enabled)`, `dedupeKey(authorUrl: string, text: string)`, `prescreen(text, config)`.
- Consumes: `Score` from `scraper/score.ts`, `PostRecord` from `server/utils/ingest.ts`.
- Produces:
  - `export interface PasteFound { emails: string[]; links: string[]; phones: string[]; refIds: string[] }`
  - `export type PasteGate = { ok: true; key: string; found: PasteFound; channels: string[] } | { ok: false; found: PasteFound; channels: string[]; enabled: readonly string[] }`
  - `export function pasteGate(text: string, config: Config): PasteGate`
  - `export function pasteRecord(text: string, config: Config, gate: Extract<PasteGate, { ok: true }>, score: Score): PostRecord`
  - `export const PASTED_TERM = 'pasted'`

Use whatever type `prescreen` names for its config parameter — import the same one it does, rather than
inventing a name.

- [ ] **Step 1: Write the failing tests**

Append to `test/paste.test.ts`:

```ts
import { emptySettings } from '../shared/settings.ts'
import { PASTED_TERM, pasteGate, pasteRecord } from '../server/utils/paste.ts'

const POST = [
  'Senior .NET Developer is required for a full-time job remotely.',
  '5+ years of experience in backend software development.',
  'C#, .NET Core, ASP.NET MVC, Entity Framework, SQL Server.',
  'apply by sending your resume to recruiter@example.com'
].join('\n')

const cfg = (over = {}) => ({ ...emptySettings(), contactChannels: ['email'], ...over })

test('pasteGate admits a post carrying an enabled channel', () => {
  const g = pasteGate(POST, cfg())
  assert.equal(g.ok, true)
  if (g.ok) {
    assert.deepEqual(g.found.emails, ['recruiter@example.com'])
    assert.ok(g.channels.includes('email'))
    assert.match(g.key, /^[0-9a-f]{40}$/)
  }
})

test('pasteGate refuses a post with no enabled channel, and says what it found', () => {
  const g = pasteGate('We are hiring a .NET developer. Visit our careers page.', cfg())
  assert.equal(g.ok, false)
  if (!g.ok) {
    assert.deepEqual(g.found.emails, [])
    assert.deepEqual(g.enabled, ['email'])
  }
})

test('pasteGate keys on the text alone, so the same paste twice is one key', () => {
  const a = pasteGate(POST, cfg())
  const b = pasteGate(POST, cfg())
  const c = pasteGate(POST + ' Extra line.', cfg())
  assert.equal(a.ok && b.ok && a.key === b.key, true)
  assert.equal(a.ok && c.ok && a.key !== c.key, true)
})

test('pasteRecord marks its origin and leaves every LinkedIn field null', () => {
  const g = pasteGate(POST, cfg())
  assert.equal(g.ok, true)
  if (!g.ok) return
  const rec = pasteRecord(POST, cfg(), g, {
    post_type: 'hiring', title: 'Senior .NET Developer', company: 'Example Ltd',
    location: 'Remote', is_remote: true, is_in_scope: true, score: 7, reason: 'matches the stack'
  })
  assert.equal(rec.searchTerm, PASTED_TERM)
  assert.equal(rec.author, null)
  assert.equal(rec.authorUrl, null)
  assert.equal(rec.postUrl, null)
  assert.equal(rec.postedAge, null)
  assert.equal(rec.postedAt, null)
  assert.equal(rec.score, 7)
  assert.equal(rec.postType, 'hiring')
  assert.equal(rec.remote, true)
  assert.equal(rec.text, POST)
  assert.deepEqual(rec.emails, ['recruiter@example.com'])
})

test("pasteRecord carries the owner's exclude flags", () => {
  const g = pasteGate(POST, cfg({ excludes: ['micro1.ai', 'Example Ltd'] }))
  assert.equal(g.ok, true)
  if (!g.ok) return
  const rec = pasteRecord(POST, cfg({ excludes: ['.NET Core'] }), g, {
    post_type: 'hiring', title: 't', company: 'c', location: 'l',
    is_remote: false, is_in_scope: false, score: 6, reason: 'r'
  })
  assert.ok(rec.flags.includes('excluded'), 'an exclude needle in pasted text must flag the row')
})
```

`PostRecord.author` and `authorUrl` are typed `string`, not `string | null`. Widen both to `string | null` in
`server/utils/ingest.ts` as part of this task — the columns are already nullable and `applyRecord` already
passes `rec.postUrl ?? null` for the same reason.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/paste.test.ts`
Expected: FAIL — `Cannot find module '../server/utils/paste.ts'`.

- [ ] **Step 3: Write `server/utils/paste.ts`**

```ts
// The pure half of the paste intake: what a pasted post yields, and whether it is admitted.
// Deliberately free of `openai`, `node:fs` and the database so test/paste.test.ts can import it
// directly — server/utils/jobs.ts cannot be imported by a test, and this logic must be.
import {
  admits, channelsOf, dedupeKey, extractEmails, extractLinks, extractPhones, extractRefIds, prescreen
} from '../../scraper/lib.ts'
import type { Score } from '../../scraper/score.ts'
import type { PostRecord } from './ingest.ts'

/** Marks the origin without colonising a real search term in the per-term yield table. */
export const PASTED_TERM = 'pasted'

export interface PasteFound { emails: string[], links: string[], phones: string[], refIds: string[] }

export type PasteGate =
  | { ok: true, key: string, found: PasteFound, channels: string[] }
  | { ok: false, found: PasteFound, channels: string[], enabled: readonly string[] }

export function pasteGate(text: string, config: Parameters<typeof prescreen>[1]): PasteGate {
  const found: PasteFound = {
    emails: extractEmails(text),
    links: extractLinks(text),
    phones: extractPhones(text),
    refIds: extractRefIds(text)
  }
  const channels = channelsOf(found, text)
  const enabled = config.contactChannels
  if (!admits(channels, enabled)) return { ok: false, found, channels, enabled }
  // An empty author URL: a paste has no author, and two pastes of the same text must give one key.
  return { ok: true, key: dedupeKey('', text), found, channels }
}

export function pasteRecord(
  text: string,
  config: Parameters<typeof prescreen>[1],
  gate: Extract<PasteGate, { ok: true }>,
  score: Score
): PostRecord {
  return {
    key: gate.key,
    searchTerm: PASTED_TERM,
    author: null,
    authorUrl: null,
    postUrl: null,
    postedAge: null,
    postedAt: null,
    postType: score.post_type,
    title: score.title,
    company: score.company,
    location: score.location,
    remote: score.is_remote,
    inScope: score.is_in_scope,
    emails: gate.found.emails,
    links: gate.found.links,
    phones: gate.found.phones,
    refIds: gate.found.refIds,
    channels: gate.channels,
    score: score.score,
    reason: score.reason,
    text,
    flags: prescreen(text, config)
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test test/paste.test.ts > /tmp/p.log 2>&1; echo "EXIT: $?"
npm test > /tmp/t.log 2>&1; echo "EXIT: $?"
npm run lint > /tmp/l.log 2>&1; echo "EXIT: $?"
npm run typecheck > /tmp/tc.log 2>&1; echo "EXIT: $?"
```
All 0. `npm test` should report 282.

- [ ] **Step 5: Commit**

```bash
git add server/utils/paste.ts server/utils/ingest.ts test/paste.test.ts
git commit -m "Decide what a pasted post yields, and whether it is admitted

pasteGate runs the same extraction and contact-route gate a scrape runs, and
pasteRecord builds the row. Both pure and in their own file: no test in this
repo can import server/utils/jobs.ts, so logic that must be tested cannot
live there.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012of8r2FB6dRNrh4FXFaSVQ"
```

---

### Task 3: The paste lane

**Files:**
- Create: `server/utils/paste-job.ts`
- Modify: `server/utils/jobs.ts`
- Test: `test/paste.test.ts` (extend with source-read invariants)

**Interfaces:**
- Consumes: `pasteGate`, `pasteRecord`, `PASTED_TERM` from `server/utils/paste.ts`; `loadCv`, `scorePost` from
  `scraper/score.ts`; `applyRecord`, `openWritableDb` from `server/utils/ingest.ts`; `readConfig` from
  `server/utils/config.ts`; `systemPrompt` from `scraper/lib.ts`.
- Produces: `export async function runPasteJob(text: string, push: (line: string) => void): Promise<number>` —
  resolves to an exit code, 0 on success.

- [ ] **Step 1: Write `server/utils/paste-job.ts`**

```ts
// The impure half of the paste intake: the CV system prompt, the scoring call and the insert.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { systemPrompt } from '../../scraper/lib.ts'
import { loadCv, scorePost } from '../../scraper/score.ts'
import { readConfig } from './config'
import { applyRecord, openWritableDb } from './ingest'
import { pasteGate, pasteRecord } from './paste'

// The CV text costs one OpenAI call to obtain and never changes while the file does not, so without a
// cache every paste pays for it. On globalThis for the reason __jobfinderRunner is: Nitro's dev HMR
// reloads this module on every edit and module scope would be discarded constantly.
interface CvCache { path: string, mtimeMs: number, system: string }
const g = globalThis as typeof globalThis & { __jobfinderCvSystem?: CvCache }

async function cvSystem(config: ReturnType<typeof readConfig>, push: (line: string) => void): Promise<string> {
  const path = resolve(process.cwd(), config.cv)
  const { mtimeMs } = statSync(path)
  if (g.__jobfinderCvSystem?.path === path && g.__jobfinderCvSystem.mtimeMs === mtimeMs) {
    return g.__jobfinderCvSystem.system
  }
  const system = systemPrompt(await loadCv(config.cv, push), config)
  g.__jobfinderCvSystem = { path, mtimeMs, system }
  return system
}

export async function runPasteJob(text: string, push: (line: string) => void): Promise<number> {
  const config = readConfig()
  const gate = pasteGate(text, config)
  if (!gate.ok) {
    // The endpoint refuses these synchronously; reaching here means the settings changed while queued.
    push(`refused: no enabled contact route (found ${gate.channels.join(', ') || 'none'})`)
    return 1
  }
  const system = await cvSystem(config, push)
  const score = await scorePost(text, system)
  const rec = pasteRecord(text, config, gate, score)
  const db = openWritableDb()
  try {
    const applied = applyRecord(db, { op: 'post', ...rec })
    push(applied
      ? `stored: ${rec.title || 'untitled'} — score ${rec.score}, ${rec.postType}${rec.flags.length ? `, flags: ${rec.flags.join(' ')}` : ''}`
      : 'already stored: this post is already in the database')
  } finally {
    db.close()
  }
  return 0
}
```

- [ ] **Step 2: Wire the lane into `server/utils/jobs.ts`**

Five edits. Each is a replacement of an existing line or block.

1. The two type unions:
```ts
export type Lane = 'scrape' | 'draft' | 'paste'
export type Kind = 'scrape' | 'rescore' | 'reflag' | 'reextract' | 'draft' | 'sync' | 'paste'
```

2. `JobArgs` — add, beside the existing fields:
```ts
  /** paste lane: the pasted post's text */
  text?: string
```

3. The lanes initialiser and the two functions under it:
```ts
const state: RunnerState = g.__jobfinderRunner ??= {
  lanes: {
    scrape: { current: null, last: null },
    draft: { current: null, last: null },
    paste: { current: null, last: null }
  },
  queue: [],
  seq: 0
}
const { lanes, queue } = state

const laneOf = (kind: Kind): Lane =>
  kind === 'paste'
    ? 'paste'
    : (kind === 'scrape' || kind === 'rescore' || kind === 'reflag' || kind === 'reextract' ? 'scrape' : 'draft')

export const busy = () => !!(lanes.scrape.current || lanes.draft.current || lanes.paste.current)
```

**An existing `__jobfinderRunner` in a running dev server has no `paste` key**, and `??=` will not add one.
`pump()` would then read `lanes.paste` as undefined and throw. Guard it immediately after the initialiser:

```ts
// A dev server that was already running holds a state object from before this lane existed.
state.lanes.paste ??= { current: null, last: null }
```

4. `stateView()` — it names each lane explicitly, so the third must be added:
```ts
export const stateView = () => ({
  lanes: {
    scrape: { current: jobView(lanes.scrape.current), last: jobView(lanes.scrape.last) },
    draft: { current: jobView(lanes.draft.current), last: jobView(lanes.draft.last) },
    paste: { current: jobView(lanes.paste.current), last: jobView(lanes.paste.last) }
  },
  queue,
  busy: busy()
})
```

5. `runJob` — add this branch directly above the existing `if (lane === 'draft') {`:
```ts
  if (lane === 'paste') {
    runPasteJob(args.text ?? '', push)
      .then(code => finish(code))
      .catch((e) => {
        push(`failed: ${(e as Error).message}`)
        finish(1)
      })
    return
  }
```

Add the import at the top of `server/utils/jobs.ts`:
```ts
import { runPasteJob } from './paste-job'
```

`pump()` needs no change: it already iterates `Object.keys(lanes)`.

- [ ] **Step 3: Write the lane invariants**

Append to `test/paste.test.ts`:

```ts
import { readFileSync } from 'node:fs'

// jobs.ts cannot be imported by a test — it pulls in the drafter, Gmail and Nitro's auto-imports — so
// the lane wiring is checked over the source, the way every other jobs.ts guard in this suite is.
test('a paste runs on its own lane, never behind a scrape or a draft', () => {
  const src = readFileSync('server/utils/jobs.ts', 'utf8')
  assert.match(src, /export type Lane = 'scrape' \| 'draft' \| 'paste'/)
  assert.match(src, /kind === 'paste'\s*\n?\s*\?\s*'paste'/, 'laneOf must map paste to its own lane')
  assert.match(src, /paste: \{ current: null, last: null \}/, 'the lanes initialiser must carry paste')
  assert.match(src, /state\.lanes\.paste \?\?=/, 'a dev server holding pre-paste state must be upgraded')
  assert.match(src, /paste: \{ current: jobView\(lanes\.paste\.current\)/, 'stateView must expose the lane')
  assert.match(src, /lanes\.paste\.current/, 'busy() must count the paste lane')
})

test('the paste job never writes a row it could not score', () => {
  // scorePost throwing must propagate to runJob's catch, not fall through to applyRecord with a
  // half-built record — the same posture as a scraped post whose score fails.
  const src = readFileSync('server/utils/paste-job.ts', 'utf8')
  const body = src.slice(src.indexOf('export async function runPasteJob'))
  assert.ok(
    body.indexOf('await scorePost(') < body.indexOf('applyRecord('),
    'the score must be awaited before the insert'
  )
  assert.doesNotMatch(body, /catch\s*\{[^}]*applyRecord/s, 'a failed score must not still insert')
})
```

- [ ] **Step 4: Run everything**

```bash
node --test test/paste.test.ts > /tmp/p.log 2>&1; echo "EXIT: $?"
npm test > /tmp/t.log 2>&1; echo "EXIT: $?"
npm run lint > /tmp/l.log 2>&1; echo "EXIT: $?"
npm run typecheck > /tmp/tc.log 2>&1; echo "EXIT: $?"
```
All 0. `npm test` should report 284.

- [ ] **Step 5: Prove the lane invariants can fail**

An invariant that cannot fail is worse than none. For **each** of the six assertions in the first new test,
break the line it guards in `server/utils/jobs.ts`, confirm that assertion fails, and revert exactly. Paste
the failing output for each into the report, and confirm `git status --porcelain` shows no leftover edit.

- [ ] **Step 6: Commit**

```bash
git add server/utils/paste-job.ts server/utils/jobs.ts test/paste.test.ts
git commit -m "Score a pasted post on its own job lane

A paste is one OpenAI call; the scrape lane is held for a whole scrape and the
draft lane for a claude session, both minutes. Queueing pastes behind either
defeats the point of backgrounding them.

The CV text is cached on globalThis, keyed by the file's path and mtime: it
costs a call to obtain and every paste would otherwise pay it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012of8r2FB6dRNrh4FXFaSVQ"
```

---

### Task 4: The endpoint

**Files:**
- Create: `server/api/posts/paste.post.ts`
- Test: `test/paste.test.ts` (extend)

**Interfaces:**
- Consumes: `pasteGate` from `server/utils/paste.ts`; `enqueue` from `server/utils/jobs.ts`; `readConfig` from
  `server/utils/config.ts`; `sqlite` from `server/utils/db.ts`.
- Produces: `POST /api/posts/paste` taking `{ text: string }` and returning one of
  `422 { error, missing }` (incomplete config) · `422 { error, found, enabled }` (no contact route) ·
  `200 { duplicate: true, key }` · `202 { queued: true, key }`.

Follow `server/api/posts/dismiss.post.ts` for the shape: a Zod `body` schema, `readValidatedBody`, and the
`sqlite` raw handle for reads.

- [ ] **Step 1: Write `server/api/posts/paste.post.ts`**

```ts
import { z } from 'zod'
import { sqlite } from '../../utils/db'
import { readConfig } from '../../utils/config'
import { enqueue } from '../../utils/jobs'
import { pasteGate } from '../../utils/paste'

const body = z.object({
  // a whole job post pasted from email or WhatsApp; the floor rejects an accidental empty submit
  text: z.string().trim().min(40, 'paste the whole post — this is too short to be one')
})

/**
 * Admit a job post that never passed through LinkedIn. The gate runs here rather than on the lane
 * because it is pure regex over a string: the owner finds out immediately whether the post was taken,
 * and only the OpenAI score is queued. The strict readConfig() is deliberate — scoring needs the CV,
 * the scope and the titles, so accepting a paste the pipeline cannot score would queue certain failure.
 */
export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)

  let config
  try {
    config = readConfig()
  } catch (e) {
    setResponseStatus(event, 422)
    return { error: (e as Error).message }
  }

  const gate = pasteGate(a.text, config)
  if (!gate.ok) {
    setResponseStatus(event, 422)
    return {
      error: 'no contact route in this post',
      found: { emails: gate.found.emails.length, links: gate.found.links.length, phones: gate.found.phones.length },
      enabled: gate.enabled
    }
  }

  if (sqlite.prepare('SELECT 1 FROM posts WHERE key = ?').get(gate.key)) {
    return { duplicate: true, key: gate.key }
  }

  const item = enqueue('paste', { text: a.text })
  setResponseStatus(event, item ? 202 : 200)
  return { queued: !!item, key: gate.key }
})
```

- [ ] **Step 2: Guard the endpoint's contract in the test**

Append to `test/paste.test.ts`:

```ts
test('the paste endpoint refuses before it queues, and never leaks the whole post back', () => {
  const src = readFileSync('server/api/posts/paste.post.ts', 'utf8')
  // The strict read is the point: a paste the pipeline cannot score must be refused, not queued.
  assert.match(src, /readConfig\(\)/, 'the endpoint must use the throwing readConfig')
  assert.ok(src.indexOf('pasteGate(') < src.indexOf('enqueue('), 'the gate must run before the enqueue')
  // Counts, not addresses: the refusal is rendered in a browser and the address is a third party's.
  assert.match(src, /emails: gate\.found\.emails\.length/, 'the refusal must report counts')
  assert.doesNotMatch(src, /found: gate\.found\s*[,}]/, 'never hand the extracted values back')
})
```

- [ ] **Step 3: Run everything**

```bash
node --test test/paste.test.ts > /tmp/p.log 2>&1; echo "EXIT: $?"
npm test > /tmp/t.log 2>&1; echo "EXIT: $?"
npm run lint > /tmp/l.log 2>&1; echo "EXIT: $?"
npm run typecheck > /tmp/tc.log 2>&1; echo "EXIT: $?"
```
All 0. `npm test` should report 285.

- [ ] **Step 4: Commit**

```bash
git add server/api/posts/paste.post.ts test/paste.test.ts
git commit -m "Accept or refuse a pasted post on the spot, queue only the score

Extraction and the contact-route gate are regex over a string, so they run in
the request and the owner gets an immediate answer. The strict readConfig is
deliberate: scoring needs the CV, the scope and the titles, so a paste the
pipeline cannot score is refused rather than queued.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012of8r2FB6dRNrh4FXFaSVQ"
```

---

### Task 5: The paste card in the Posts view

**Files:**
- Modify: `app/pages/posts.vue`

**Interfaces:**
- Consumes: `POST /api/posts/paste` (Task 4), `GET /api/job` for the paste lane's log.

Read `app/pages/posts.vue` in full before editing, and follow its existing conventions: Nuxt UI v4
components, `useFetch`/`$fetch` as the file already uses them, and `class="shrink-0"` on any card —
`UDashboardPanel`'s `#body` is a flex column and a card without it is clipped rather than scrolled.

- [ ] **Step 1: Read the file first**

Read `app/pages/posts.vue` in full before editing. The code below is complete, but the names it uses for the
posts-list refresh (`refresh()` in Step 2) must be replaced with whatever this file actually calls — it uses
`useFetch`, so there is an existing refresh function to reuse rather than invent.

- [ ] **Step 2: Add the state and the submit handler**

In `<script setup>`:

```ts
interface PasteEntry {
  at: number
  state: 'queued' | 'stored' | 'refused' | 'failed'
  detail: string
  text: string
}

const pasteText = ref('')
const pasting = ref(false)
const pastes = ref<PasteEntry[]>([])

const pasteReady = computed(() => pasteText.value.trim().length >= 40 && !pasting.value)

function describeRefusal(d: { error?: string, found?: { emails: number, links: number, phones: number }, enabled?: string[] }): string {
  if (!d.found) return d.error || 'refused'
  const { emails, links, phones } = d.found
  return `no contact route — ${emails} emails, ${links} links, ${phones} phones; you accept: ${(d.enabled || []).join(', ')}`
}

async function submitPaste() {
  const text = pasteText.value.trim()
  if (!text) return
  pasting.value = true
  try {
    const r = await $fetch<{ queued?: boolean, duplicate?: boolean }>('/api/posts/paste', {
      method: 'POST',
      body: { text }
    })
    if (r.duplicate) {
      pastes.value.unshift({ at: Date.now(), state: 'refused', detail: 'you already have this post', text })
    } else {
      pastes.value.unshift({ at: Date.now(), state: 'queued', detail: 'queued for scoring', text })
      startPastePolling()
    }
    pasteText.value = ''           // accepted or already known: nothing left to recover
  } catch (e) {
    // $fetch throws on a non-2xx and puts the parsed body on `.data`
    const d = (e as { data?: Record<string, never> }).data || {}
    pastes.value.unshift({ at: Date.now(), state: 'refused', detail: describeRefusal(d), text })
    // deliberately NOT cleared: a refused paste must not be lost
  } finally {
    pasting.value = false
  }
}

function pasteAgain(entry: PasteEntry) {
  pasteText.value = entry.text
}
```

- [ ] **Step 3: Add the polling**

Still in `<script setup>`. Poll only while something is outstanding, and stop as soon as nothing is — an
always-on interval on a dashboard page is a needless request every two seconds forever.

```ts
let pasteTimer: ReturnType<typeof setInterval> | null = null

function stopPastePolling() {
  if (pasteTimer) { clearInterval(pasteTimer); pasteTimer = null }
}

function startPastePolling() {
  if (pasteTimer) return
  pasteTimer = setInterval(pollPasteLane, 2000)
}

async function pollPasteLane() {
  const queued = pastes.value.filter(p => p.state === 'queued')
  if (!queued.length) return stopPastePolling()

  const s = await $fetch<{ lanes: { paste?: { current: { log: string[] } | null, last: { log: string[] } | null } } }>('/api/job')
  const last = s.lanes.paste?.last
  if (!last || s.lanes.paste?.current) return   // still running: wait for it to land in `last`

  const line = last.log.at(-1) || ''
  const oldest = queued[queued.length - 1]!
  if (line.startsWith('stored:') || line.startsWith('already stored:')) {
    oldest.state = 'stored'
    oldest.detail = line
    await refresh()                              // rename to this file's own posts refresh
  } else if (line) {
    oldest.state = 'failed'
    oldest.detail = line
  }
  if (!pastes.value.some(p => p.state === 'queued')) stopPastePolling()
}

onUnmounted(stopPastePolling)
```

- [ ] **Step 4: Add the template**

Above the posts table, matching the file's existing card usage. `class="shrink-0"` is not optional —
`UDashboardPanel`'s `#body` is a flex column and a card without it is clipped rather than scrolled.

```vue
<UCard class="shrink-0 mb-4">
  <template #header>
    <span class="font-medium">Paste a post</span>
    <span class="text-xs text-muted ml-2">arrived by email or WhatsApp</span>
  </template>

  <UTextarea
    v-model="pasteText"
    :rows="6"
    placeholder="Paste the whole job post, including however it says to apply."
    class="w-full"
  />

  <template #footer>
    <div class="flex items-center gap-3">
      <UButton :disabled="!pasteReady" :loading="pasting" @click="submitPaste">Add post</UButton>
      <span class="text-xs text-muted">Scored in the background — you can paste another straight away.</span>
    </div>

    <ul v-if="pastes.length" class="mt-3 space-y-1">
      <li v-for="p in pastes" :key="p.at" class="flex items-center gap-2 text-sm">
        <UBadge
          :color="p.state === 'stored' ? 'success' : p.state === 'queued' ? 'neutral' : 'error'"
          variant="subtle"
        >{{ p.state }}</UBadge>
        <span class="truncate">{{ p.detail }}</span>
        <UButton
          v-if="p.state === 'refused' || p.state === 'failed'"
          size="xs"
          variant="ghost"
          @click="pasteAgain(p)"
        >Paste again</UButton>
      </li>
    </ul>
  </template>
</UCard>
```

- [ ] **Step 5: Verify the view renders**

The Claude-in-Chrome extension cannot open localhost, so use the screenshot script:

```bash
node scripts/screenshot.mjs /tmp/shots > /tmp/sh.log 2>&1; echo "EXIT: $?"
```

Read `/tmp/shots/posts.png` with the Read tool and confirm the card is present, is not clipped, and that the
table below it still renders. Do not start or restart the dev server; the script drives its own headless
Chrome.

- [ ] **Step 6: Run the gates**

```bash
npm test > /tmp/t.log 2>&1; echo "EXIT: $?"
npm run lint > /tmp/l.log 2>&1; echo "EXIT: $?"
npm run typecheck > /tmp/tc.log 2>&1; echo "EXIT: $?"
```
All 0.

- [ ] **Step 7: Commit**

```bash
git add app/pages/posts.vue
git commit -m "Paste a job post from the Posts view

The refusal arrives in the box, with what was found against what is enabled,
and keeps the text so a rejected paste is not lost. Queued pastes report their
outcome from the paste lane's log.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012of8r2FB6dRNrh4FXFaSVQ"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the intake**

In the **The pipeline, end to end** section, add a fifth numbered item after the UI one:

> 5. **Paste intake** `server/api/posts/paste.post.ts` + `server/utils/paste.ts` / `paste-job.ts`: a post that
>    arrived by email or WhatsApp, pasted into the Posts view. The endpoint runs the same extraction and
>    contact-route gate a scrape runs — pure regex, so a refusal is immediate — and queues only the OpenAI
>    score, onto a **third job lane**. The row it writes is an ordinary one: `search_term = 'pasted'`,
>    `author` / `author_url` / `post_url` null, and **no exemption anywhere downstream**. A pasted post that
>    scores 4 does not draft, exactly like a scraped one.

In the **Data model** section, under `posts`, add to the `search_term` discussion (or beside it):

> `search_term = 'pasted'` marks a post that entered through the paste box rather than a search. It is its own
> bucket in the per-term yield table, so pasting never inflates a real term's numbers.

In **The server and the UI** gotchas, add:

> - **Three job lanes now**, not two: `scrape`, `draft` and `paste`. `pump()` iterates `Object.keys(lanes)` so
>   it needed no change, but `busy()` and `stateView()` name every lane explicitly and a fourth would have to
>   be added to both. **`state.lanes.paste ??=` after the initialiser is load-bearing**: `__jobfinderRunner`
>   survives HMR, so a dev server running from before the lane existed holds a state object without the key,
>   and `??=` on the whole object will not add it.

- [ ] **Step 2: Correct the stale branch claim**

`CLAUDE.md`'s **What this is** section says the rewrite lives on `nuxt-rewrite` and that `main` holds the
original Node + Postgres version. That is false: `main` is the rewrite and is what feature branches merge
into. Replace that paragraph's first sentence with one stating that `main` carries the Nuxt rewrite, keeping
the pointer to the design specs that follows it.

- [ ] **Step 3: Run the gates and commit**

```bash
npm test > /tmp/t.log 2>&1; echo "EXIT: $?"
npm run lint > /tmp/l.log 2>&1; echo "EXIT: $?"
```
Both 0.

```bash
git add CLAUDE.md
git commit -m "Document the paste intake and the third job lane

Also corrects the claim that main holds the pre-rewrite version: main is the
rewrite, and is what this branch merges into.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012of8r2FB6dRNrh4FXFaSVQ"
```

---

## Live verification — the owner's, not an implementer's

Not a task. Creating rows from a real pasted post is the owner's to run, and it makes real OpenAI calls.

1. Settings → **Working hours** must have a value, or every paste returns 422. (`readConfig()` throws
   without it, which also blocks drafting and the nightly sweep.)
2. Paste a real post into the Posts view. Expect: accepted, `queued`, then `stored` within a few seconds.
3. Paste the **same** post again. Expect: *"you already have this post."*
4. Paste a post with no email in it. Expect: refused, with the counts, and the text still in the box.
5. Confirm the row in the Posts list shows the scorer's title and company, and that its Flags and Channel
   badges match a scraped row's.
