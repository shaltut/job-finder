# Application Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record, for every post the owner applies to, what it asks for and whether the CV shows it, and rank those gaps on a read-only Gaps page with a copyable keyword list.

**Architecture:** A `gaps` job on the draft lane reads each application post against the master CV with one OpenAI call, and code keeps only rows whose quotes appear verbatim in the post and (for present/partial) in the CV. Rows land in `post_requirements`, one `requirement_runs` row per post records which CV it was read against. `GET /api/gaps` aggregates them into Learn / Add now / On your CV, computing "on your CV" against the current master CV at read time.

**Tech Stack:** Nuxt 4 + Nitro, Nuxt UI v4, Drizzle ORM + better-sqlite3, OpenAI Responses API (`openai` package), `node:test` with Node 22 type stripping.

**Spec:** `docs/superpowers/specs/2026-09-21-application-gaps-design.md`

## Global Constraints

- Node is pinned by Volta to 22.23.2; `npm`, never pnpm. No new dependencies.
- Any file a test imports must use **explicit `.ts` import specifiers** and must not import `./db`, `./config` or `./jobs` (Nitro resolves extensionless imports; `node --test` does not). `server/utils/gaps.ts` and `shared/gaps.ts` are test-imported.
- The Nitro server is the sole writer of `data/jobfinder.db`.
- Model: `process.env.JOBFINDER_GAPS_MODEL || 'gpt-5-mini'`, `reasoning: { effort: 'medium' }`, strict JSON schema. Never the scorer's nano (it returns an empty table on this task).
- `MIN_QUOTE = 8`: a quote whose `matchKey()` is shorter is dropped.
- Status vocabulary is `present` | `partial` | `absent` (as `shared/background.ts`).
- Categories: `technology`, `domain`, `certification`, `practice`, `language`, `other`. Importance: `must`, `nice`.
- Exported names from `server/utils/` are auto-imported globally by Nitro, so they must be specific: `RequirementStatus`, `RequirementCategory`, `RequirementImportance`, `GapRow`, `DroppedRequirement`, `GapRunMeta`, `REQUIREMENT_CATEGORIES` — never bare `Status`/`Category` (and `RequirementRow` is already taken by `shared/background.ts`).
- An application is `applications.verdict = 'drafted'` OR `posts.applied_at IS NOT NULL`.
- Nothing in this feature writes to the CV, `data/cv/master.json`, `settings.background.gaps` or the drafter prompt.
- Test fixtures use `example.com` addresses only — `test/identity.test.ts` fails the build on the owner's real details.
- Working-copy line endings are mixed CRLF/LF and git normalises on commit; edit with the Edit tool, and if a script rewrites a file, preserve its existing line endings.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/db/schema.ts` (modify) | `postRequirements`, `requirementRuns` tables |
| `server/db/migrations/0007_*.sql` (generated) | the migration |
| `server/utils/gaps.ts` (create) | pure + SQL: schema, instructions, verification, selection, storage, orchestration, aggregation. Test-importable |
| `shared/gaps.ts` (create) | browser-safe: response types, `modeStatus`, `groupFor`, `keywordList` |
| `server/utils/gaps-job.ts` (create) | impure: the OpenAI call, master CV, db handle → `extractGaps` |
| `server/utils/jobs.ts` (modify) | `gaps` kind, dedupe, dispatch, post-draft trigger |
| `server/utils/cv-tailor.ts` (modify) | export `masterText` |
| `server/utils/cv-master.ts` (modify) | export `readCache` |
| `server/api/run/gaps.post.ts` (create) | enqueue endpoint |
| `server/api/gaps.get.ts` (create) | the page's data |
| `server/api/posts/applied.post.ts` (modify) | trigger on Mark applied |
| `server/tasks/daily.ts` (modify) | daily trigger |
| `app/types/index.d.ts` (modify) | `JobKind` gains `'gaps'` |
| `app/pages/run.vue` (modify) | Extract gaps button |
| `app/pages/gaps.vue` (create) | the page |
| `app/layouts/default.vue` (modify) | sidebar entry |
| `test/gaps.test.ts` (create) | all tests for this feature |
| `CLAUDE.md` (modify) | tables, grouping rule, analysis query, honesty rule |

---

### Task 1: The two tables

**Files:**
- Modify: `server/db/schema.ts` (imports at line 2; append after the `contacts` table)
- Create (generated): `server/db/migrations/0007_*.sql`, `server/db/migrations/meta/0007_snapshot.json`, `server/db/migrations/meta/_journal.json`
- Test: `test/gaps.test.ts`

**Interfaces:**
- Produces: SQL tables `post_requirements (key, term, category, importance, status, quote, cv_shows)` with PK `(key, term)`, and `requirement_runs (key PK, cv_sha, model, kept, dropped, extracted_at)`; both cascade on post delete. Drizzle exports `postRequirements`, `requirementRuns`.

- [ ] **Step 1: Write the failing test** — create `test/gaps.test.ts`:

```ts
// The gap record: what each application post asks for, judged against the master CV. These tests run
// against a real migrated database with the model call injected, so nothing here touches OpenAI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'

let dir: string
let db: Database.Database

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-gaps-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A distinct 40-character key per test, so tests sharing one database never see each other's rows. */
const k = (n: number) => String(n).padStart(40, '0')

const POST = 'Senior Backend Engineer. Requirements: 5+ years of Kubernetes in production; strong PostgreSQL '
  + 'query tuning. Nice to have: experience with Terraform modules.'

const addPost = (key: string, text = POST) => applyRecord(db, {
  op: 'post', key, searchTerm: 'x', author: 'A', authorUrl: 'https://www.linkedin.com/in/a', postUrl: null,
  postedAge: '1h', postedAt: '2026-09-21T09:00:00.000Z', postType: 'hiring', title: 'Senior Backend Engineer',
  company: 'Acme', location: null, remote: true, inScope: true, emails: ['hr@example.com'], links: [], phones: [],
  refIds: [], channels: ['email'], score: 7, reason: '', text, flags: []
} as ScraperRecord)

const count = (table: string, key: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE key = ?`).get(key) as { n: number }).n

test('both tables exist, and deleting a post deletes its requirements and its run', () => {
  const key = k(1)
  addPost(key)
  db.prepare(`INSERT INTO post_requirements (key, term, category, importance, status, quote, cv_shows)
    VALUES (?, 'Kubernetes', 'technology', 'must', 'absent', '5+ years of Kubernetes', '')`).run(key)
  db.prepare(`INSERT INTO requirement_runs (key, cv_sha, model, kept, dropped) VALUES (?, 'sha', 'm', 1, 0)`).run(key)
  assert.equal(count('post_requirements', key), 1)
  assert.equal(count('requirement_runs', key), 1)

  db.prepare('DELETE FROM posts WHERE key = ?').run(key)

  assert.equal(count('post_requirements', key), 0, 'requirements cascade with the post')
  assert.equal(count('requirement_runs', key), 0, 'the run cascades with the post')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/gaps.test.ts`
Expected: FAIL — `no such table: post_requirements`

- [ ] **Step 3: Add the tables** — in `server/db/schema.ts` change line 2 to:

```ts
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
```

and append after the `contacts` table definition (before the `export type Post` lines):

```ts
/**
 * One row per requirement an application post states, judged against the master CV. Written only by the
 * `gaps` job (server/utils/gaps.ts), and only rows whose quotes survived verification: `quote` is in the
 * post, and `cv_shows` is in the master CV unless the status is `absent`, when it is ''. The status
 * vocabulary is shared/background.ts's — one meaning of "partial" in this codebase, not two.
 */
export const postRequirements = sqliteTable('post_requirements', {
  key: text('key').notNull().references(() => posts.key, { onDelete: 'cascade' }),
  /** the keyword as a CV would write it; unique per post case-insensitively, enforced in code */
  term: text('term').notNull(),
  category: text('category', { enum: ['technology', 'domain', 'certification', 'practice', 'language', 'other'] }).notNull(),
  importance: text('importance', { enum: ['must', 'nice'] }).notNull(),
  status: text('status', { enum: ['present', 'partial', 'absent'] }).notNull(),
  quote: text('quote').notNull(),
  cvShows: text('cv_shows').notNull().default('')
}, t => [
  primaryKey({ columns: [t.key, t.term] })
])

/**
 * One row per post the gaps job has read, and against which CV. It is what tells "done, nothing stated"
 * from "not attempted", and what makes a new CV visible: a run whose `cv_sha` differs from the current
 * CV's is stale and gets read again.
 */
export const requirementRuns = sqliteTable('requirement_runs', {
  key: text('key').primaryKey().references(() => posts.key, { onDelete: 'cascade' }),
  /** pdfSha256 of the CV this post was read against */
  cvSha: text('cv_sha').notNull(),
  model: text('model').notNull(),
  /** rows stored / rows the checks discarded — a rising drop count is a drifting prompt */
  kept: integer('kept').notNull(),
  dropped: integer('dropped').notNull(),
  extractedAt: integer('extracted_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
})
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `server/db/migrations/0007_<name>.sql` containing `CREATE TABLE \`post_requirements\`` with `PRIMARY KEY(\`key\`, \`term\`)` and `CREATE TABLE \`requirement_runs\``, both with `ON DELETE cascade`. Read the file and confirm; do not hand-edit it. (Do not run `npm run db:migrate`: the dev server migrates at boot, and the test migrates its own temp database.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/gaps.test.ts`
Expected: PASS, 1 test

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/migrations test/gaps.test.ts
git commit -m "Add the post_requirements and requirement_runs tables"
```

---

### Task 2: What the model returns, and what survives it

**Files:**
- Create: `server/utils/gaps.ts`
- Test: `test/gaps.test.ts` (append)

**Interfaces:**
- Consumes: `matchKey(text: string): string` from `server/utils/cv-master.ts` (already exported).
- Produces (all exported from `server/utils/gaps.ts`):
  - `type RequirementCategory = 'technology' | 'domain' | 'certification' | 'practice' | 'language' | 'other'`
  - `type RequirementImportance = 'must' | 'nice'`, `type RequirementStatus = 'present' | 'partial' | 'absent'`
  - `interface RawRequirement { term: string, category: RequirementCategory, importance: RequirementImportance, quote: string, status: RequirementStatus, cvShows: string }`
  - `interface DroppedRequirement { row: RawRequirement, why: string }`
  - `const MIN_QUOTE = 8`
  - `const REQUIREMENTS_SCHEMA` (strict JSON schema, root `{ requirements: RawRequirement[] }`)
  - `function requirementsInstructions(): string`
  - `function verifyRequirements(rows: RawRequirement[], postText: string, cvText: string): { kept: RawRequirement[], dropped: DroppedRequirement[] }`

- [ ] **Step 1: Write the failing tests** — append to `test/gaps.test.ts` (and add the import at the top with the others):

```ts
import { verifyRequirements, type RawRequirement } from '../server/utils/gaps.ts'
```

```ts
const CV = 'Led the migration to PostgreSQL, including query tuning with pg_stat_statements.\n'
  + 'Deployed services with Argo CD on Kubernetes clusters.'

const req = (over: Partial<RawRequirement> = {}): RawRequirement => ({
  term: 'Kubernetes',
  category: 'technology',
  importance: 'must',
  quote: '5+ years of Kubernetes in production',
  status: 'partial',
  cvShows: 'Argo CD on Kubernetes clusters',
  ...over
})

test('a requirement survives only when its quote is in the post', () => {
  const invented = req({ term: 'Go', quote: '3 years of Go microservices', status: 'absent', cvShows: '' })
  const { kept, dropped } = verifyRequirements([req(), invented], POST, CV)
  assert.deepEqual(kept.map(r => r.term), ['Kubernetes'])
  assert.deepEqual(dropped.map(d => d.why), ['quote is not in the post'])
})

test('whitespace, case and punctuation do not break a quote match', () => {
  const { kept } = verifyRequirements([req({ quote: '5+  YEARS of kubernetes, in production' })], POST, CV)
  assert.equal(kept.length, 1)
})

test('a quote too short to check is dropped rather than trusted', () => {
  // "Go" keys to "go", which is inside "Google", "going", "ago" — it proves nothing
  const { dropped } = verifyRequirements([req({ quote: 'Kubernetes' })], POST, CV)
  assert.deepEqual(dropped.map(d => d.why), [])
  const short = verifyRequirements([req({ quote: 'Kube' })], POST, CV)
  assert.deepEqual(short.dropped.map(d => d.why), ['quote too short to check'])
})

test('present and partial must quote the CV, and absent must not', () => {
  const rows = [
    req({ term: 'A', status: 'present', cvShows: '' }),
    req({ term: 'B', status: 'partial', cvShows: 'ten years of Kubernetes operations' }),
    req({ term: 'C', status: 'absent', cvShows: 'Argo CD on Kubernetes clusters' }),
    req({ term: 'Terraform', status: 'absent', cvShows: '', quote: 'experience with Terraform modules', importance: 'nice' })
  ]
  const { kept, dropped } = verifyRequirements(rows, POST, CV)
  assert.deepEqual(kept.map(r => r.term), ['Terraform'], 'only the honest absence survives')
  assert.deepEqual(dropped.map(d => d.why), [
    'present with no checkable CV quote',
    'CV quote is not in the CV',
    'marked absent but quotes the CV'
  ])
  assert.equal(kept[0]!.cvShows, '', 'an absence stores no CV quote')
})

test('the same term twice on one post is kept once, case-insensitively', () => {
  const { kept, dropped } = verifyRequirements([req(), req({ term: 'kubernetes ' })], POST, CV)
  assert.equal(kept.length, 1)
  assert.deepEqual(dropped.map(d => d.why), ['duplicate term'])
})

test('an empty term is dropped and a long one is capped', () => {
  const { kept, dropped } = verifyRequirements([req({ term: '  ' }), req({ term: 'K'.repeat(80) })], POST, CV)
  assert.deepEqual(dropped.map(d => d.why), ['no term'])
  assert.equal(kept[0]!.term.length, 60)
})
```

Note the third test deliberately asserts that a 10-character quote (`Kubernetes`) passes: the minimum guards against two- and four-letter quotes, not ordinary single words.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/gaps.test.ts`
Expected: FAIL — `Cannot find module '.../server/utils/gaps.ts'`

- [ ] **Step 3: Create `server/utils/gaps.ts`**

```ts
// The gap record: what the posts the owner applies to ask for, judged against the master CV.
//
// Test-importable on purpose — explicit .ts imports, nothing that reaches ./db, ./config or ./jobs — so
// the checks that decide what survives, the selection and the aggregation run under node:test without a
// network. The OpenAI call and the job wiring live in gaps-job.ts.
//
// THE RISK THIS FILE CONTAINS is shared/background.ts's: a requirement the post never stated, or a
// "present" the CV does not support, steers the CV rewrite and the learning plan wrong. So the model fills
// in a verdict table and code drops every row it cannot justify, with quotes checked verbatim on BOTH
// sides — the post, and the CV.
import { matchKey } from './cv-master.ts'

export const REQUIREMENT_CATEGORIES = ['technology', 'domain', 'certification', 'practice', 'language', 'other'] as const
export type RequirementCategory = typeof REQUIREMENT_CATEGORIES[number]
export type RequirementImportance = 'must' | 'nice'
export type RequirementStatus = 'present' | 'partial' | 'absent'

/** One row as the model returns it. Nothing here is trusted until verifyRequirements() has seen it. */
export interface RawRequirement {
  term: string
  category: RequirementCategory
  importance: RequirementImportance
  quote: string
  status: RequirementStatus
  cvShows: string
}

export interface DroppedRequirement { row: RawRequirement, why: string }

/** Below this many letters and digits a quote proves nothing: "Go" keys to "go", inside "Google". */
export const MIN_QUOTE = 8

export const REQUIREMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'category', 'importance', 'quote', 'status', 'cvShows'],
        properties: {
          term: { type: 'string' },
          category: { type: 'string', enum: [...REQUIREMENT_CATEGORIES] },
          importance: { type: 'string', enum: ['must', 'nice'] },
          quote: { type: 'string' },
          status: { type: 'string', enum: ['present', 'partial', 'absent'] },
          cvShows: { type: 'string' }
        }
      }
    }
  }
} as const

/** The system prompt. The post comes first and the CV second, so requirements are read, not invented. */
export function requirementsInstructions(): string {
  return `You are reading one job post the candidate has applied to, beside their CV, to record what the
post asks for and whether the CV shows it. The record decides what they learn next and how they improve
their CV, so an invented requirement or a generous "present" does real damage. Returning less is better.

Work from the POST first. List every skill, technology, domain, certification, practice or spoken
language the post states as a requirement or a preference, and nothing it does not state. Then look for
each one in the CV.

For each requirement:
  term       - the keyword as a CV would write it, in its common canonical form: "React", not "ReactJS"
               or "React.js developer"; "Kubernetes", not "K8s". One concept per entry.
  category   - technology (languages, frameworks, tools, platforms, databases, clouds), domain (an
               industry or business area), certification, practice (a methodology or way of working),
               language (a spoken language), or other.
  importance - "must" when the post states it as required; "nice" when it says preferred, a plus, nice
               to have or bonus. When the post does not say, "must".
  quote      - the post's own words that state it, copied exactly, at least a few words long. An entry
               whose quote is not in the post is discarded.
  status     - "present": the CV plainly shows it. "partial": the CV shows some of it, less of it, an
               older version of it, or something adjacent. "absent": the CV does not show it anywhere.
  cvShows    - for "present" and "partial", the CV's own words that settle it, copied exactly. For
               "absent", the empty string. An "absent" entry that quotes the CV is a contradiction and is
               discarded, and so is a "present" or "partial" entry whose words are not in the CV.

Do not list years of experience, a seniority level, a location, a salary or working hours: those are not
skills. Do not list a requirement in order to be able to mark it absent.`
}

/** Why this row may not be stored, or null when it may. Order matters only for the message. */
function rejection(r: RawRequirement, term: string, post: string, cv: string, seen: Set<string>): string | null {
  if (!term) return 'no term'
  if (seen.has(term.toLowerCase())) return 'duplicate term'
  const quote = matchKey(String(r.quote ?? ''))
  if (quote.length < MIN_QUOTE) return 'quote too short to check'
  if (!post.includes(quote)) return 'quote is not in the post'
  const shows = matchKey(String(r.cvShows ?? ''))
  if (r.status === 'absent') return shows ? 'marked absent but quotes the CV' : null
  if (r.status !== 'present' && r.status !== 'partial') return 'unknown status'
  if (shows.length < MIN_QUOTE) return `${r.status} with no checkable CV quote`
  if (!cv.includes(shows)) return 'CV quote is not in the CV'
  return null
}

/**
 * The rows that survive. Every drop is returned with its reason rather than swallowed, so the job log can
 * count them — a rising drop count is how a drifting prompt gets noticed.
 */
export function verifyRequirements(
  rows: RawRequirement[], postText: string, cvText: string
): { kept: RawRequirement[], dropped: DroppedRequirement[] } {
  const post = matchKey(postText)
  const cv = matchKey(cvText)
  const kept: RawRequirement[] = []
  const dropped: DroppedRequirement[] = []
  const seen = new Set<string>()

  for (const r of Array.isArray(rows) ? rows : []) {
    const term = String(r?.term ?? '').trim().slice(0, 60)
    const why = rejection(r, term, post, cv, seen)
    if (why) {
      dropped.push({ row: r, why })
      continue
    }
    seen.add(term.toLowerCase())
    kept.push({
      ...r,
      term,
      quote: String(r.quote).trim(),
      cvShows: r.status === 'absent' ? '' : String(r.cvShows).trim()
    })
  }
  return { kept, dropped }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/gaps.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/utils/gaps.ts test/gaps.test.ts
git commit -m "Verify gap rows against the post and the CV before keeping them"
```

---

### Task 3: Which posts to read, storing a run, and the loop

**Files:**
- Modify: `server/utils/gaps.ts` (append)
- Test: `test/gaps.test.ts` (append)

**Interfaces:**
- Consumes: `verifyRequirements`, `RawRequirement` (Task 2); the tables (Task 1).
- Produces (exported from `server/utils/gaps.ts`):
  - `type Db = import('better-sqlite3').Database` (type-only import)
  - `function pendingApplications(db: Db, cvSha: string): { key: string, text: string }[]`
  - `interface GapRunMeta { cvSha: string, model: string, dropped: number }`
  - `function storeRun(db: Db, key: string, kept: RawRequirement[], meta: GapRunMeta): void`
  - `interface GapsDeps { ask: (postText: string, cvText: string) => Promise<RawRequirement[]>, cvText: string, cvSha: string, model: string }`
  - `function extractGaps(db: Db, deps: GapsDeps, push: (line: string) => void, signal?: AbortSignal): Promise<{ stored: number, pending: number }>`

- [ ] **Step 1: Write the failing tests** — extend the import from Task 2 to:

```ts
import { extractGaps, pendingApplications, storeRun, verifyRequirements, type RawRequirement } from '../server/utils/gaps.ts'
```

and append:

```ts
const draft = (key: string) =>
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'drafted', 'named in application')`).run(key)
const skip = (key: string) =>
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'skipped', 'outside the field')`).run(key)
const applyByHand = (key: string) => db.prepare('UPDATE posts SET applied_at = unixepoch() WHERE key = ?').run(key)
const pendingOf = (sha: string, mine: string[]) =>
  pendingApplications(db, sha).map(p => p.key).filter(key => mine.includes(key)).sort()

test('an application is a drafted post or one applied to by hand, and nothing else', () => {
  const [drafted, applied, skipped, untouched] = [k(10), k(11), k(12), k(13)]
  for (const key of [drafted, applied, skipped, untouched]) addPost(key)
  draft(drafted)
  applyByHand(applied)
  skip(skipped)
  assert.deepEqual(pendingOf('sha-1', [drafted, applied, skipped, untouched]), [drafted, applied])
})

test('a post read against this CV is done, and a new CV makes it pending again', () => {
  const key = k(20)
  addPost(key)
  draft(key)
  storeRun(db, key, [], { cvSha: 'sha-1', model: 'm', dropped: 0 })
  assert.deepEqual(pendingOf('sha-1', [key]), [], 'read against the current CV: done, even with no rows')
  assert.deepEqual(pendingOf('sha-2', [key]), [key], 'a different CV makes it stale')
})

test('a re-run replaces the post\'s rows and its run, never mixing old and new', () => {
  const key = k(30)
  addPost(key)
  draft(key)
  storeRun(db, key, [req({ term: 'A' }), req({ term: 'B' })], { cvSha: 'sha-1', model: 'm', dropped: 2 })
  storeRun(db, key, [req({ term: 'C' })], { cvSha: 'sha-2', model: 'm2', dropped: 0 })
  const terms = db.prepare('SELECT term FROM post_requirements WHERE key = ? ORDER BY term').all(key) as { term: string }[]
  assert.deepEqual(terms.map(t => t.term), ['C'])
  const run = db.prepare('SELECT cv_sha, model, kept, dropped FROM requirement_runs WHERE key = ?').get(key)
  assert.deepEqual(run, { cv_sha: 'sha-2', model: 'm2', kept: 1, dropped: 0 })
})

test('the loop stores what verifies, leaves a failed call pending, and says so', async () => {
  const [ok, broken, empty] = [k(40), k(41), k(42)]
  // distinct text per post, so the fake model below can tell them apart
  addPost(ok)
  addPost(broken, `${POST} BROKEN`)
  addPost(empty, `${POST} EMPTY`)
  for (const key of [ok, broken, empty]) draft(key)
  const log: string[] = []
  const invented = req({ term: 'Go', quote: '3 years of Go microservices', status: 'absent', cvShows: '' })
  const res = await extractGaps(db, {
    cvText: CV,
    cvSha: 'sha-loop',
    model: 'fake',
    ask: async (text) => {
      if (text.includes('BROKEN')) throw new Error('rate limited')
      if (text.includes('EMPTY')) return []
      return [req(), invented]
    }
  }, line => log.push(line))

  // the fixture posts from earlier tests are pending under this sha too, so compare only ours
  assert.equal(count('post_requirements', ok), 1, 'the verified row is stored, the invented one is not')
  assert.equal(count('requirement_runs', broken), 0, 'a failed call writes nothing, so it is retried next run')
  assert.equal(count('requirement_runs', empty), 1, 'an empty table is still a completed read')
  assert.ok(res.stored < res.pending, 'the failure is visible in the counts')
  assert.ok(log.some(l => l.includes('rate limited') && l.includes('left for the next run')))
  assert.ok(log.some(l => l.includes('no requirements at all') && l.includes('JOBFINDER_GAPS_MODEL')))
  assert.ok(log.some(l => l.includes('quote is not in the post')), 'drops are reported with their reason')
})

test('Stop is honoured between posts', async () => {
  const key = k(50)
  addPost(key)
  draft(key)
  const abort = new AbortController()
  abort.abort()
  const log: string[] = []
  const res = await extractGaps(db, { cvText: CV, cvSha: 'sha-stop', model: 'fake', ask: async () => [req()] },
    line => log.push(line), abort.signal)
  assert.equal(res.stored, 0)
  assert.ok(log.includes('stopped'))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/gaps.test.ts`
Expected: FAIL — `pendingApplications is not a function` (or the equivalent SyntaxError on the missing export)

- [ ] **Step 3: Append to `server/utils/gaps.ts`**

Add at the top, under the existing import:

```ts
import type Database from 'better-sqlite3'

type Db = Database.Database
```

Append at the end:

```ts
/**
 * Application posts not yet read against this CV: drafted by the app, or applied to by hand. Newest
 * application first, so a backfill that is stopped part-way has read the posts that matter most.
 */
export function pendingApplications(db: Db, cvSha: string): { key: string, text: string }[] {
  return db.prepare(`
    SELECT p.key, p.text FROM posts p
    LEFT JOIN applications a ON a.key = p.key
    LEFT JOIN requirement_runs r ON r.key = p.key
    WHERE (a.verdict = 'drafted' OR p.applied_at IS NOT NULL)
      AND (r.key IS NULL OR r.cv_sha <> ?)
    ORDER BY coalesce(p.applied_at, a.created_at) DESC
  `).all(cvSha) as { key: string, text: string }[]
}

export interface GapRunMeta { cvSha: string, model: string, dropped: number }

/** Replaces the post's rows and its run in one transaction, so a post is never half old CV, half new. */
export function storeRun(db: Db, key: string, kept: RawRequirement[], meta: GapRunMeta): void {
  db.transaction(() => {
    db.prepare('DELETE FROM post_requirements WHERE key = ?').run(key)
    const insert = db.prepare(`
      INSERT INTO post_requirements (key, term, category, importance, status, quote, cv_shows)
      VALUES (@key, @term, @category, @importance, @status, @quote, @cvShows)
    `)
    for (const r of kept) {
      insert.run({ key, term: r.term, category: r.category, importance: r.importance, status: r.status, quote: r.quote, cvShows: r.cvShows })
    }
    db.prepare(`
      INSERT INTO requirement_runs (key, cv_sha, model, kept, dropped, extracted_at)
      VALUES (@key, @cvSha, @model, @kept, @dropped, unixepoch())
      ON CONFLICT (key) DO UPDATE SET
        cv_sha = excluded.cv_sha, model = excluded.model, kept = excluded.kept,
        dropped = excluded.dropped, extracted_at = excluded.extracted_at
    `).run({ key, cvSha: meta.cvSha, model: meta.model, kept: kept.length, dropped: meta.dropped })
  })()
}

export interface GapsDeps {
  /** the model call: the post and the CV text in, the raw verdict table out */
  ask: (postText: string, cvText: string) => Promise<RawRequirement[]>
  cvText: string
  cvSha: string
  model: string
}

/**
 * Reads every pending application once. A failed call writes nothing, so the post is simply pending
 * again next time — the posture a failed score has. `stored < pending` is how the caller knows to exit 1.
 */
export async function extractGaps(
  db: Db, deps: GapsDeps, push: (line: string) => void, signal?: AbortSignal
): Promise<{ stored: number, pending: number }> {
  const pending = pendingApplications(db, deps.cvSha)
  if (!pending.length) {
    push('gaps: every application is already read against the current CV')
    return { stored: 0, pending: 0 }
  }
  push(`gaps: ${pending.length} application(s) to read with ${deps.model}`)
  let stored = 0
  for (const p of pending) {
    if (signal?.aborted) {
      push('stopped')
      break
    }
    const id = p.key.slice(0, 8)
    let raw: RawRequirement[]
    try {
      raw = await deps.ask(p.text, deps.cvText)
    } catch (e) {
      push(`${id}: ${(e as Error).message} — left for the next run`)
      continue
    }
    const { kept, dropped } = verifyRequirements(raw, p.text, deps.cvText)
    storeRun(db, p.key, kept, { cvSha: deps.cvSha, model: deps.model, dropped: dropped.length })
    stored++
    // An empty table is valid against the strict schema, which is exactly how nano failed on this task:
    // say so rather than let it read as a post that asks for nothing.
    if (!raw.length) {
      push(`${id}: the model returned no requirements at all — if this repeats, set JOBFINDER_GAPS_MODEL to a stronger model`)
    } else {
      const why = [...new Set(dropped.map(d => d.why))].join('; ')
      push(`${id}: ${kept.length} kept${dropped.length ? `, ${dropped.length} dropped (${why})` : ''}`)
    }
  }
  push(`gaps: ${stored} of ${pending.length} read`)
  return { stored, pending: pending.length }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/gaps.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add server/utils/gaps.ts test/gaps.test.ts
git commit -m "Select, read and store gap records per application"
```

---

### Task 4: The job — wiring, triggers and the Run button

**Files:**
- Create: `server/utils/gaps-job.ts`, `server/api/run/gaps.post.ts`
- Modify: `server/utils/cv-tailor.ts:43` (export `masterText`), `server/utils/jobs.ts`, `server/api/posts/applied.post.ts`, `server/tasks/daily.ts`, `app/types/index.d.ts:52`, `app/pages/run.vue` (Maintenance row)

**Interfaces:**
- Consumes: `extractGaps`, `REQUIREMENTS_SCHEMA`, `requirementsInstructions`, `RawRequirement` (Tasks 2-3); `loadMasterCv(pdfPath)`, `pdfSha256(bytes)` from `cv-master.ts`; `readConfigLoose()`, `cvPath(cfg)` from `config.ts`; `cvExists(p)` from `cv.ts`; `openWritableDb()` from `ingest.ts`.
- Produces: `masterText(m: MasterCv): string` exported from `cv-tailor.ts`; `runGapsJob(job: { added: number }, push: (line: string) => void, signal: AbortSignal): Promise<number>` from `gaps-job.ts`; job kind `'gaps'`; `POST /api/run/gaps` → `{ ...JobState, queued: boolean, note?: string }`.

This task has no unit test: `jobs.ts` cannot be imported by any test in this repo (CLAUDE.md), and the rest is wiring. Its check is typecheck, lint and the full suite here, and the live curl in Task 7.

- [ ] **Step 1: Export `masterText`** — in `server/utils/cv-tailor.ts` change

```ts
const masterText = (m: MasterCv): string => [
```

to

```ts
/** Every text field of the master CV, one per line — the full view the gap record checks quotes against. */
export const masterText = (m: MasterCv): string => [
```

- [ ] **Step 2: Create `server/utils/gaps-job.ts`**

```ts
// The impure half of the gap record: the OpenAI call, the master CV and the database handle that
// extractGaps (server/utils/gaps.ts) takes as arguments, so the orchestration stays testable there.
import { readFileSync } from 'node:fs'
import OpenAI from 'openai'
import { cvPath, readConfigLoose } from './config'
import { cvExists } from './cv'
import { loadMasterCv, pdfSha256 } from './cv-master'
import { masterText } from './cv-tailor'
import { extractGaps, REQUIREMENTS_SCHEMA, requirementsInstructions, type RawRequirement } from './gaps'
import { openWritableDb } from './ingest'

/**
 * gpt-5-mini by default, not the scorer's nano: on this exact kind of per-requirement table nano returned
 * an empty array — valid against the strict schema, so the failure is silent. Measured in
 * server/api/settings/background.post.ts (nano 0 requirements, mini 17).
 */
const MODEL = process.env.JOBFINDER_GAPS_MODEL || 'gpt-5-mini'

let openai: OpenAI | undefined

async function ask(postText: string, cvText: string): Promise<RawRequirement[]> {
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'medium' },
    input: [
      { role: 'system', content: requirementsInstructions() },
      { role: 'user', content: `--- JOB POST ---\n${postText}\n\n--- CV ---\n${cvText}` }
    ],
    text: { format: { type: 'json_schema', name: 'post_requirements', strict: true, schema: REQUIREMENTS_SCHEMA } }
  } as never) as { output_text: string }
  return (JSON.parse(r.output_text) as { requirements: RawRequirement[] }).requirements
}

/** The `gaps` job. Exit 0 when every pending application was read, 1 otherwise. */
export async function runGapsJob(job: { added: number }, push: (line: string) => void, signal: AbortSignal): Promise<number> {
  // loose, not readConfig(): reading gaps needs the CV and nothing a scrape needs
  const config = readConfigLoose()
  if (!config.cv || !cvExists(config.cv)) {
    push('gaps: no CV uploaded — upload one in Settings first')
    return 1
  }
  if (!process.env.OPENAI_API_KEY) {
    push('gaps: OPENAI_API_KEY is not set — add it to .env and restart')
    return 1
  }
  const path = cvPath(config)
  // a cache hit costs nothing; a new CV costs the two extraction calls once, as tailoring already does
  const master = await loadMasterCv(path)
  const { db, close } = openWritableDb()
  try {
    const { stored, pending } = await extractGaps(db, {
      ask,
      cvText: masterText(master),
      cvSha: pdfSha256(readFileSync(path)),
      model: MODEL
    }, push, signal)
    job.added = stored
    return stored === pending ? 0 : 1
  } finally {
    close()
  }
}
```

- [ ] **Step 3: Wire the kind into `server/utils/jobs.ts`**

3a. Add the import beside the others (after `import { runPasteJob } from './paste-job'`):

```ts
import { runGapsJob } from './gaps-job'
```

3b. Change the `Kind` union to:

```ts
export type Kind = 'scrape' | 'rescore' | 'reflag' | 'reextract' | 'draft' | 'sync' | 'paste' | 'gaps'
```

`laneOf()` needs no change: every kind that is not `paste` or a scrape kind already maps to `'draft'`.

3c. In `enqueue()`, after the `sync` dedupe line, add:

```ts
  // Deduped against the QUEUE only, unlike sync: a gaps job already running chose its posts when it
  // started, so an application that arrives mid-run needs the queued one to pick it up.
  if (kind === 'gaps' && queue.some(q => q.kind === 'gaps')) return null
```

3d. In `runJob`'s draft-lane branch, replace

```ts
    const work = kind === 'sync' ? runSyncJob(push) : runDraftJob(job, args, push, abort.signal)
```

with

```ts
    const work = kind === 'sync'
      ? runSyncJob(push)
      : (kind === 'gaps' ? runGapsJob(job, push, abort.signal) : runDraftJob(job, args, push, abort.signal))
```

3e. In `runDraftJob`, replace the final `return 0` inside the `try` (the one right after the `cv: N tailored, M fell back` line) with:

```ts
    // every drafted post is a new application: read it for the gap record, after this lane frees up
    if (job.added) enqueue('gaps')
    return 0
```

- [ ] **Step 4: Create `server/api/run/gaps.post.ts`**

```ts
import { enqueue, stateView } from '../../utils/jobs'

/**
 * The gap record's catch-up job: reads every application not yet read against the current CV. The same
 * job is the backfill, the post-draft trigger and the daily one, because selection is idempotent.
 */
export default defineEventHandler((event) => {
  const item = enqueue('gaps')
  setResponseStatus(event, item ? 202 : 200)
  return { ...stateView(), queued: !!item, note: item ? undefined : 'a gaps run is already queued' }
})
```

- [ ] **Step 5: Trigger on Mark applied** — replace the body of `server/api/posts/applied.post.ts`'s handler:

```ts
export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)
  const updated = setApplied(sqlite, a.keys, a.applied)
  // an application made by hand is still an application: read it for the gap record
  if (a.applied && updated) enqueue('gaps')
  return { updated }
})
```

and add `import { enqueue } from '../../utils/jobs'` beside the other imports.

- [ ] **Step 6: Trigger daily** — in `server/tasks/daily.ts`, after the sweep's `try { … } catch { … }` block and before `const summary`, add:

```ts
    // A newly uploaded CV makes every gap record stale; this re-reads them without anyone remembering.
    // Costs nothing when nothing is pending: the master CV is cached and the selection comes back empty.
    try {
      enqueue('gaps', { auto: true })
      messages.push('gaps queued')
    } catch (e) {
      messages.push(`gaps not queued: ${(e as Error).message}`)
    }
```

- [ ] **Step 7: The client type** — in `app/types/index.d.ts` change line 52 to:

```ts
export type JobKind = 'scrape' | 'rescore' | 'reflag' | 'reextract' | 'draft' | 'sync' | 'paste' | 'gaps'
```

- [ ] **Step 8: The Run button** — in `app/pages/run.vue`, inside the Maintenance footer, after the `Rescore all` button, add:

```vue
            <UButton
              label="Extract gaps"
              icon="i-lucide-list-checks"
              color="neutral"
              variant="outline"
              size="sm"
              title="Read every application not yet read against the current CV, for the Gaps page. Costs OpenAI calls."
              @click="post('/api/run/gaps')"
            />
```

No `:disabled`: it runs on the draft lane, not the scrape lane, and `enqueue` dedupes a second press.

- [ ] **Step 9: Verify**

Run: `npm run typecheck` — Expected: exit 0, no errors
Run: `npm run lint` — Expected: exit 0
Run: `npm test` — Expected: all pass (the suite count grows by the 12 tests of Tasks 1-3)

- [ ] **Step 10: Commit**

```bash
git add server/utils/gaps-job.ts server/api/run/gaps.post.ts server/utils/cv-tailor.ts server/utils/jobs.ts server/api/posts/applied.post.ts server/tasks/daily.ts app/types/index.d.ts app/pages/run.vue
git commit -m "Run the gap record as a draft-lane job after drafts, Mark applied, daily and on demand"
```

---

### Task 5: Ranking and grouping, and the page's endpoint

**Files:**
- Create: `shared/gaps.ts`, `server/api/gaps.get.ts`
- Modify: `server/utils/gaps.ts` (append), `server/utils/cv-master.ts` (export `readCache`)
- Test: `test/gaps.test.ts` (append)

**Interfaces:**
- Consumes: `excludeRule(list: readonly string[]): RegExp | null` from `scraper/lib.ts`; `masterText` (Task 4); `readCache`, `MASTER_CACHE`, `MASTER_CACHE_VERSION`, `pdfSha256` from `cv-master.ts`.
- Produces:
  - `shared/gaps.ts`: `type GapStatus`, `type GapGroup = 'learn' | 'add' | 'on-cv'`, `interface GapPost`, `interface GapTerm`, `interface GapsResponse { terms: GapTerm[], applications: number, analysed: number }`, `modeStatus(statuses: GapStatus[]): GapStatus`, `groupFor(status: GapStatus, inCv: boolean): GapGroup`, `keywordList(terms: GapTerm[]): string`
  - `server/utils/gaps.ts`: `interface GapRow`, `requirementRows(db: Db): GapRow[]`, `applicationCounts(db: Db, cvSha: string): { applications: number, analysed: number }`, `aggregateGaps(rows: GapRow[], cvText: string): GapTerm[]`
  - `GET /api/gaps` → `GapsResponse`

- [ ] **Step 1: Write the failing tests** — add imports at the top:

```ts
import { keywordList, modeStatus, type GapTerm } from '../shared/gaps.ts'
```

and extend the `server/utils/gaps.ts` import with `aggregateGaps, applicationCounts, requirementRows, type GapRow`. Append:

```ts
test('the most frequent status wins, and a tie goes to the worse one', () => {
  assert.equal(modeStatus(['present', 'present', 'absent']), 'present')
  assert.equal(modeStatus(['present', 'absent']), 'absent', 'a split verdict never hides a gap')
  assert.equal(modeStatus(['partial', 'present']), 'partial')
  assert.equal(modeStatus(['partial', 'absent', 'partial']), 'partial')
})

const row = (over: Partial<GapRow>): GapRow => ({
  key: k(900), term: 'React', category: 'technology', importance: 'must', status: 'absent',
  quote: 'q', cvShows: '', title: 'T', company: 'C', postUrl: null, appliedAt: 1_758_441_600, ...over
})

test('grouping: absent is Learn; otherwise On your CV when the CV names it on whole words, else Add now', () => {
  const cv = 'Built APIs in C# on .NET 8, deployed on Google Cloud.'
  const terms = aggregateGaps([
    row({ term: 'React', status: 'absent' }),
    row({ term: 'C#', status: 'present' }),
    row({ term: '.NET', status: 'partial' }),
    row({ term: 'Go', status: 'partial' }) // "Google" must not count as Go
  ], cv)
  const group = Object.fromEntries(terms.map(t => [t.term, t.group]))
  assert.deepEqual(group, { 'React': 'learn', 'C#': 'on-cv', '.NET': 'on-cv', 'Go': 'add' })
})

test('terms group case-insensitively and rank by applications, then must-haves', () => {
  const terms = aggregateGaps([
    row({ key: k(901), term: 'Kafka' }),
    row({ key: k(902), term: 'kafka', importance: 'nice' }),
    row({ key: k(903), term: 'Terraform' }),
    row({ key: k(904), term: 'Rust', importance: 'nice' }),
    row({ key: k(905), term: 'Rust', importance: 'nice' })
  ], '')
  assert.deepEqual(terms.map(t => [t.term, t.applications, t.must]), [
    ['Kafka', 2, 1], ['Rust', 2, 0], ['Terraform', 1, 1]
  ])
  assert.equal(terms[0]!.posts.length, 2, 'every application behind the term is listed')
  assert.equal(terms[0]!.lastSeen, new Date(1_758_441_600_000).toISOString())
})

test('the copyable list has Add now, then Learn, and leaves out what is already on the CV', () => {
  const t = (term: string, group: GapTerm['group'], applications: number, must: number): GapTerm =>
    ({ term, category: 'technology', group, applications, must, lastSeen: null, posts: [] })
  assert.equal(keywordList([t('React', 'learn', 12, 8), t('GitOps', 'add', 7, 5), t('C#', 'on-cv', 20, 20), t('Rust', 'learn', 1, 0)]),
    'Add now — you have it, your CV doesn\'t say it\n'
    + '- GitOps — 7 applications (5 must-have)\n\n'
    + 'Learn — not on your CV yet\n'
    + '- React — 12 applications (8 must-have)\n'
    + '- Rust — 1 application (0 must-have)')
})

test('the page reads application rows only, and counts what was read against the current CV', () => {
  const [a, b, gone] = [k(60), k(61), k(62)]
  for (const key of [a, b, gone]) addPost(key)
  draft(a)
  applyByHand(b)
  skip(gone) // rows left behind by a post that is not an application must not be ranked
  storeRun(db, a, [req({ term: 'ZetaTerm' })], { cvSha: 'sha-page', model: 'm', dropped: 0 })
  storeRun(db, b, [req({ term: 'ZetaTerm' })], { cvSha: 'sha-old', model: 'm', dropped: 0 })
  storeRun(db, gone, [req({ term: 'ZetaTerm' })], { cvSha: 'sha-page', model: 'm', dropped: 0 })

  const zeta = requirementRows(db).filter(r => r.term === 'ZetaTerm').map(r => r.key).sort()
  assert.deepEqual(zeta, [a, b])
  const counts = applicationCounts(db, 'sha-page')
  assert.ok(counts.applications >= 2)
  assert.ok(counts.analysed < counts.applications, 'b was read against an older CV, so it is not counted')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/gaps.test.ts`
Expected: FAIL — `Cannot find module '.../shared/gaps.ts'`

- [ ] **Step 3: Create `shared/gaps.ts`**

```ts
// The Gaps page's model: the response shape of GET /api/gaps and the rules that turn statuses into
// groups. Pure and import-free, like shared/paste-poll.ts, so the page, the server and node:test all read
// one definition.

export type GapStatus = 'present' | 'partial' | 'absent'

/** learn: the CV does not show it. add: the experience is there, the keyword is not. on-cv: both are. */
export type GapGroup = 'learn' | 'add' | 'on-cv'

export interface GapPost {
  key: string
  title: string | null
  company: string | null
  postUrl: string | null
  importance: 'must' | 'nice'
  status: GapStatus
  /** the post's own words */
  quote: string
  /** the CV's own words; '' when absent */
  cvShows: string
  /** ISO date of the application */
  appliedAt: string | null
}

export interface GapTerm {
  term: string
  category: string
  group: GapGroup
  /** distinct applications asking */
  applications: number
  /** of those, how many make it a must-have */
  must: number
  lastSeen: string | null
  posts: GapPost[]
}

export interface GapsResponse {
  terms: GapTerm[]
  applications: number
  /** applications whose run carries the current CV's sha */
  analysed: number
}

/** The most frequent status; a tie goes to the worse one, so a split verdict never hides a gap. */
export function modeStatus(statuses: GapStatus[]): GapStatus {
  const n: Record<GapStatus, number> = { present: 0, partial: 0, absent: 0 }
  for (const s of statuses) n[s]++
  // worst first, replaced only by a strictly larger count
  return (['absent', 'partial', 'present'] as const).reduce((best, s) => (n[s] > n[best] ? s : best))
}

export function groupFor(status: GapStatus, inCv: boolean): GapGroup {
  if (status === 'absent') return 'learn'
  return inCv ? 'on-cv' : 'add'
}

const line = (t: GapTerm) =>
  `- ${t.term} — ${t.applications} application${t.applications === 1 ? '' : 's'} (${t.must} must-have)`

/** The copyable list, in the order given (already ranked). On your CV is left out: nothing to change. */
export function keywordList(terms: GapTerm[]): string {
  const section = (title: string, group: GapGroup) => {
    const ts = terms.filter(t => t.group === group)
    return ts.length ? [title, ...ts.map(line)].join('\n') : ''
  }
  return [
    section('Add now — you have it, your CV doesn\'t say it', 'add'),
    section('Learn — not on your CV yet', 'learn')
  ].filter(Boolean).join('\n\n')
}
```

- [ ] **Step 4: Append the aggregation to `server/utils/gaps.ts`**

Add to the imports at the top:

```ts
import { excludeRule } from '../../scraper/lib.ts'
import { groupFor, modeStatus, type GapTerm } from '../../shared/gaps.ts'
```

Append at the end:

```ts
/** One requirement row of one application post, with what the page shows beside it. */
export interface GapRow {
  key: string
  term: string
  category: string
  importance: RequirementImportance
  status: RequirementStatus
  quote: string
  cvShows: string
  title: string | null
  company: string | null
  postUrl: string | null
  /** epoch seconds: the draft's created_at, or applied_at for a post applied to by hand */
  appliedAt: number | null
}

/**
 * Every stored requirement of every application post. Filtered on the application predicate again, not
 * just on the rows existing: a post un-marked applied keeps its rows, and must stop being ranked.
 */
export function requirementRows(db: Db): GapRow[] {
  return db.prepare(`
    SELECT r.key, r.term, r.category, r.importance, r.status, r.quote, r.cv_shows AS cvShows,
           p.title, p.company, p.post_url AS postUrl,
           coalesce(CASE WHEN a.verdict = 'drafted' THEN a.created_at END, p.applied_at) AS appliedAt
    FROM post_requirements r
    JOIN posts p ON p.key = r.key
    LEFT JOIN applications a ON a.key = p.key
    WHERE (a.verdict = 'drafted' OR p.applied_at IS NOT NULL)
  `).all() as GapRow[]
}

/** How many applications exist, and how many were read against the CV with this sha. */
export function applicationCounts(db: Db, cvSha: string): { applications: number, analysed: number } {
  return db.prepare(`
    SELECT count(*) AS applications, count(r.key) AS analysed
    FROM posts p
    LEFT JOIN applications a ON a.key = p.key
    LEFT JOIN requirement_runs r ON r.key = p.key AND r.cv_sha = ?
    WHERE (a.verdict = 'drafted' OR p.applied_at IS NOT NULL)
  `).get(cvSha) as { applications: number, analysed: number }
}

const mostFrequent = (xs: string[]): string => {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n.entries()].reduce((best, e) => (e[1] > best[1] ? e : best))[0]
}

const iso = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString() : null)

/**
 * Terms across applications, grouped case-insensitively and ranked by how many applications ask, then how
 * many make it a must-have. `cvText` is the CURRENT master CV, so "on your CV" follows a CV update before
 * any re-extraction. The match is excludeRule()'s: whole words where \b can see the edge, so `C#` and
 * `.NET` still match and `Go` does not match "Google".
 */
export function aggregateGaps(rows: GapRow[], cvText: string): GapTerm[] {
  const byTerm = new Map<string, GapRow[]>()
  for (const r of rows) {
    const id = r.term.toLowerCase()
    byTerm.set(id, [...(byTerm.get(id) ?? []), r])
  }
  return [...byTerm.values()].map((rs): GapTerm => {
    const term = mostFrequent(rs.map(r => r.term))
    const inCv = !!cvText && !!excludeRule([term])?.test(cvText)
    const last = Math.max(...rs.map(r => r.appliedAt ?? 0))
    return {
      term,
      category: mostFrequent(rs.map(r => r.category)),
      group: groupFor(modeStatus(rs.map(r => r.status)), inCv),
      applications: new Set(rs.map(r => r.key)).size,
      must: new Set(rs.filter(r => r.importance === 'must').map(r => r.key)).size,
      lastSeen: iso(last || null),
      posts: rs.map(r => ({
        key: r.key, title: r.title, company: r.company, postUrl: r.postUrl, importance: r.importance,
        status: r.status, quote: r.quote, cvShows: r.cvShows, appliedAt: iso(r.appliedAt)
      }))
    }
  }).sort((a, b) => b.applications - a.applications || b.must - a.must || a.term.localeCompare(b.term))
}
```

- [ ] **Step 5: Export `readCache`** — in `server/utils/cv-master.ts` change `function readCache(path: string): CachedMaster | null {` to:

```ts
export function readCache(path: string): CachedMaster | null {
```

- [ ] **Step 6: Create `server/api/gaps.get.ts`**

```ts
import { readFileSync } from 'node:fs'
import type { GapsResponse } from '../../shared/gaps'
import { cvPath, readConfigLoose } from '../utils/config'
import { cvExists } from '../utils/cv'
import { MASTER_CACHE, MASTER_CACHE_VERSION, pdfSha256, readCache } from '../utils/cv-master'
import { masterText } from '../utils/cv-tailor'
import { sqlite } from '../utils/db'
import { aggregateGaps, applicationCounts, requirementRows } from '../utils/gaps'

/**
 * The Gaps page. Read-only, and it never calls a model: "on your CV" is matched against the cached master
 * CV, and a CV uploaded since shows up as fewer applications analysed until the gaps job re-reads them.
 * A cache from an older MasterCv shape is ignored rather than spread — masterText would throw on it.
 */
export default defineEventHandler((): GapsResponse => {
  const config = readConfigLoose()
  const sha = config.cv && cvExists(config.cv) ? pdfSha256(readFileSync(cvPath(config))) : ''
  const cached = readCache(MASTER_CACHE)
  const cvText = cached?.version === MASTER_CACHE_VERSION ? masterText(cached.cv) : ''
  return { terms: aggregateGaps(requirementRows(sqlite), cvText), ...applicationCounts(sqlite, sha) }
})
```

- [ ] **Step 7: Run to verify**

Run: `node --test test/gaps.test.ts` — Expected: PASS, 17 tests
Run: `npm run typecheck` — Expected: exit 0
Run: `curl -s http://127.0.0.1:3939/api/gaps` (dev server running) — Expected: `{"terms":[],"applications":110,"analysed":0}` or close (the application count is live)

- [ ] **Step 8: Commit**

```bash
git add shared/gaps.ts server/utils/gaps.ts server/utils/cv-master.ts server/api/gaps.get.ts test/gaps.test.ts
git commit -m "Rank gaps into Learn, Add now and On your CV for the Gaps page"
```

---

### Task 6: The Gaps page

**Files:**
- Create: `app/pages/gaps.vue`
- Modify: `app/layouts/default.vue` (the `links` array)

**Interfaces:**
- Consumes: `GET /api/gaps` → `GapsResponse`; `keywordList`, `GapGroup`, `GapTerm`, `GapsResponse` from `#shared/gaps` (Task 5).

- [ ] **Step 1: Sidebar entry** — in `app/layouts/default.vue`, insert between the Pipeline and Run entries:

```ts
}, {
  label: 'Gaps',
  icon: 'i-lucide-target',
  to: '/gaps',
  onSelect: close
```

- [ ] **Step 2: Create `app/pages/gaps.vue`**

```vue
<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { keywordList, type GapGroup, type GapsResponse, type GapTerm } from '#shared/gaps'

useDashboard()
useHead({ title: 'Gaps' })

const toast = useToast()
const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

const { data, status } = await useFetch<GapsResponse>('/api/gaps', {
  lazy: true,
  default: () => ({ terms: [], applications: 0, analysed: 0 })
})

const show = ref<'gaps' | GapGroup | 'all'>('gaps')
const category = ref('all')
const expanded = ref<Record<string, boolean>>({})

const categories = computed(() => ['all', ...new Set(data.value.terms.map(t => t.category))])

const rows = computed(() => data.value.terms.filter(t =>
  (show.value === 'all' || (show.value === 'gaps' ? t.group !== 'on-cv' : t.group === show.value))
  && (category.value === 'all' || t.category === category.value)))

const GROUP: Record<GapGroup, { label: string, color: 'error' | 'warning' | 'success' }> = {
  'learn': { label: 'Learn', color: 'error' },
  'add': { label: 'Add now', color: 'warning' },
  'on-cv': { label: 'On your CV', color: 'success' }
}

const columns: TableColumn<GapTerm>[] = [
  {
    id: 'expand',
    cell: ({ row }) => h(UButton, {
      icon: row.getIsExpanded() ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
      color: 'neutral',
      variant: 'ghost',
      size: 'xs',
      onClick: () => row.toggleExpanded()
    })
  },
  {
    accessorKey: 'term',
    header: 'Keyword',
    cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, row.original.term)
  },
  {
    accessorKey: 'category',
    header: 'RequirementCategory',
    cell: ({ row }) => h('span', { class: 'text-muted' }, row.original.category)
  },
  {
    id: 'asked',
    header: 'Asked by',
    cell: ({ row }) => {
      const t = row.original
      return `${t.applications} application${t.applications === 1 ? '' : 's'} · ${t.must} must-have`
    }
  },
  {
    accessorKey: 'group',
    header: 'Group',
    cell: ({ row }) => h(UBadge, { variant: 'subtle', color: GROUP[row.original.group].color }, () => GROUP[row.original.group].label)
  },
  {
    accessorKey: 'lastSeen',
    header: 'Last seen',
    cell: ({ row }) => h('span', { class: 'text-xs text-muted' }, row.original.lastSeen?.slice(0, 10) ?? '—')
  }
]

async function copyList() {
  try {
    await navigator.clipboard.writeText(keywordList(data.value.terms))
    toast.add({ title: 'Keyword list copied', icon: 'i-lucide-clipboard-check' })
  } catch (e) {
    toast.add({ title: 'Could not copy', description: String(e), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel id="gaps">
    <template #header>
      <UDashboardNavbar title="Gaps">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            label="Copy keyword list"
            icon="i-lucide-clipboard"
            color="neutral"
            variant="outline"
            :disabled="!data.terms.some(t => t.group !== 'on-cv')"
            @click="copyList"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="text-sm text-muted shrink-0">
        {{ data.analysed }} of {{ data.applications }} applications analysed against your current CV.
        <template v-if="data.analysed < data.applications">
          Press <ULink to="/run">Extract gaps</ULink> in the Run view to read the rest.
        </template>
      </p>

      <div class="flex flex-wrap items-center gap-1.5 shrink-0">
        <USelect
          v-model="show"
          :items="[
            { label: 'Add now + Learn', value: 'gaps' },
            { label: 'Add now', value: 'add' },
            { label: 'Learn', value: 'learn' },
            { label: 'On your CV', value: 'on-cv' },
            { label: 'All', value: 'all' }
          ]"
          class="w-44"
        />
        <USelect
          v-model="category"
          :items="categories.map(c => ({ label: c === 'all' ? 'Any category' : c, value: c }))"
          class="w-44"
        />
        <span class="text-sm text-muted ml-auto">{{ rows.length }} keywords</span>
      </div>

      <UTable
        v-model:expanded="expanded"
        :data="rows"
        :columns="columns"
        :get-row-id="(t: GapTerm) => t.term.toLowerCase()"
        :loading="status === 'pending'"
        class="shrink-0"
      >
        <template #expanded="{ row }">
          <ul class="p-4 space-y-3 text-sm">
            <li
              v-for="p in row.original.posts"
              :key="p.key"
              class="space-y-1"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-highlighted">{{ p.title || 'Untitled role' }}</span>
                <span
                  v-if="p.company"
                  class="text-muted"
                >@ {{ p.company }}</span>
                <UBadge
                  variant="subtle"
                  color="neutral"
                  size="sm"
                >
                  {{ p.importance === 'must' ? 'must-have' : 'nice-to-have' }}
                </UBadge>
                <UBadge
                  variant="subtle"
                  color="neutral"
                  size="sm"
                >
                  {{ p.status }}
                </UBadge>
                <ULink
                  v-if="p.postUrl"
                  :to="p.postUrl"
                  target="_blank"
                  class="text-xs"
                >
                  View post
                </ULink>
              </div>
              <p class="text-muted italic">
                “{{ p.quote }}”
              </p>
              <p
                v-if="p.cvShows"
                class="text-xs text-muted"
              >
                Your CV: {{ p.cvShows }}
              </p>
            </li>
          </ul>
        </template>
      </UTable>

      <div
        v-if="!rows.length && status !== 'pending'"
        class="py-16 text-center text-muted"
      >
        No keywords here yet.
      </div>
    </template>
  </UDashboardPanel>
</template>
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — Expected: exit 0
Run: `npm run lint` — Expected: exit 0
Then screenshot the page headlessly. The Claude-in-Chrome extension cannot open localhost (CLAUDE.md), so drive the installed Chrome through `playwright-core`. Create `logs/gaps-shot.mjs` — `logs/` is gitignored, and a script inside the project resolves its `node_modules`:

```js
// Throwaway: screenshot /gaps, and again with the first row expanded when there is one.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

mkdirSync('logs/shots', { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => m.type() === 'error' && errors.push(m.text()))

await page.goto('http://127.0.0.1:3939/gaps', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
await page.screenshot({ path: 'logs/shots/gaps.png' })

const expand = page.locator('tbody button').first()
if (await expand.count()) {
  await expand.click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'logs/shots/gaps-expanded.png', fullPage: true })
}
console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
```

Run: `node logs/gaps-shot.mjs`, then read `logs/shots/gaps.png`.
Expected: `no console errors`; the Gaps entry in the sidebar; the header line `0 of <N> applications analysed against your current CV. Press Extract gaps…`; the two selects; "No keywords here yet."

- [ ] **Step 4: Commit**

```bash
git add app/pages/gaps.vue app/layouts/default.vue
git commit -m "Add the Gaps page: ranked keywords, grouping filters and a copyable list"
```

---

### Task 7: Backfill live, document for Claude Code, verify end to end

**Files:**
- Modify: `CLAUDE.md` (Data model section, after the `contacts` bullet)

**Interfaces:**
- Consumes: everything above, against the real database.

- [ ] **Step 1: Queue the backfill and check the dedupe**

With `npm run dev` running, press nothing in the UI; run three POSTs back to back:

```bash
for i in 1 2 3; do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3939/api/run/gaps; done
```

Expected: `202`, `202`, `200` — the first starts running on the idle draft lane, the second queues behind it, the third is refused because one is already queued. (If a draft job happens to be running, the first queues and the second returns 200.)

- [ ] **Step 2: Watch it finish**

Poll `curl -s http://127.0.0.1:3939/api/job` until `lanes.draft.current` is null, then read `lanes.draft.last.log` (or the Run view's log card).
Expected: a first line `gaps: <N> application(s) to read with gpt-5-mini`, one line per post with kept/dropped counts, a final `gaps: <N> of <N> read`, exit 0. The second, queued job then logs `gaps: every application is already read against the current CV`.
If more than a handful of posts log `returned no requirements at all`, stop and report — that is the silent-empty failure the model choice exists to prevent.

- [ ] **Step 3: Check the numbers in the database**

Create `logs/gaps-counts.mjs` (gitignored, like the screenshot script):

```js
// Throwaway: what the backfill stored, read-only.
import Database from 'better-sqlite3'

const db = new Database('data/jobfinder.db', { readonly: true })
const show = (label, sql) => console.log(label, db.prepare(sql).all())
show('applications:', `SELECT count(*) AS n FROM posts p LEFT JOIN applications a ON a.key = p.key
  WHERE a.verdict = 'drafted' OR p.applied_at IS NOT NULL`)
show('runs:', 'SELECT count(*) AS n FROM requirement_runs')
show('kept/dropped:', 'SELECT sum(kept) AS kept, sum(dropped) AS dropped FROM requirement_runs')
show('runs with nothing kept:', 'SELECT count(*) AS n FROM requirement_runs WHERE kept = 0')
show('top terms:', `SELECT term, count(*) AS n, sum(status = 'absent') AS absent FROM post_requirements
  GROUP BY lower(term) ORDER BY n DESC LIMIT 15`)
```

Run: `node logs/gaps-counts.mjs`
Expected: runs equal applications; dropped well under kept (if drops exceed a third of all rows, read the drop reasons in the job log before going further); the top terms read as real skills from real posts.

- [ ] **Step 4: Screenshot the page with data**

Run: `node logs/gaps-shot.mjs` (the script from Task 6, Step 3 — it takes the expanded shot itself once rows exist). Read `logs/shots/gaps.png` and `logs/shots/gaps-expanded.png`.
Expected: header `<N> of <N> applications analysed`, rows ranked by application count, group badges in three colours, an expanded row showing quotes and CV lines, and **Copy keyword list** enabled.

- [ ] **Step 5: Document for Claude Code** — in `CLAUDE.md`, in the Data model section after the `contacts` bullet, add:

```markdown
- **`post_requirements` / `requirement_runs`** — the gap record, for improving the CV and choosing what to
  learn. For every **application** (`applications.verdict = 'drafted'` or `posts.applied_at` set) the
  `gaps` job reads the post against the master CV with one `gpt-5-mini` call (`JOBFINDER_GAPS_MODEL`) and
  stores each requirement: `term`, `category`, `importance` must|nice, `status` present|partial|absent,
  the post's `quote` and the CV's `cv_shows`. **Both quotes are verified verbatim in code**
  (`verifyRequirements` in `server/utils/gaps.ts`, `matchKey` comparison, 8-character minimum): a row whose
  post quote is not in the post, or whose present/partial CV quote is not in the master CV, is never
  stored, and an `absent` row carries no CV quote. `requirement_runs` records which CV (`cv_sha` =
  `pdfSha256`) each post was read against, so uploading a new CV makes every run stale and the next job
  re-reads them. Triggers: after a draft job that drafted, after Mark applied, daily, and **Extract gaps**
  in the Run view. `enqueue('gaps')` dedupes against the **queue only** — a running job already chose its
  posts. The **Gaps** page groups each term: **Learn** when its most frequent status is `absent` (ties go
  to the worse), else **On your CV** when `excludeRule([term])` matches the current master CV text, else
  **Add now** — the experience is there, the keyword is not.
  **Analysing it with Claude Code**: the CV to enhance is `data/cv/master.json` (the uploaded PDF, extracted
  and cached); the ranked record is
  ```bash
  sqlite3 data/jobfinder.db "select r.term, r.category, count(*) apps, sum(r.importance='must') must,
    group_concat(distinct r.status), group_concat(r.quote, ' | ') from post_requirements r
    join posts p on p.key = r.key left join applications a on a.key = p.key
    where a.verdict = 'drafted' or p.applied_at is not null
    group by lower(r.term) order by apps desc, must desc"
  ```
  **The one rule for any CV-enhancement pass: Add now keywords may go onto the CV; Learn keywords may not
  until the skill is real.** `tailoredCv()` refuses technology the master CV does not name, so the base CV
  is the only place honesty can slip — this is where it is held.
```

- [ ] **Step 6: Full verification**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three exit 0; the test count includes the 17 in `test/gaps.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the gap record for Claude Code, and the one honesty rule for CV passes"
```
