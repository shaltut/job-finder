# Posts Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Posts view into a grid: sortable column headers, filters inside the headers, URL-backed view state, a country filter, and bulk Draft / Exclude with range selection.

**Architecture:** Sorting, filtering and paging stay server-side in `server/api/posts.get.ts`. Every piece of logic worth a test lives in a pure module the test runner can import — `shared/countries.ts` (country resolution), `shared/posts-view.ts` (URL ⇄ view state, chips, sort cycling, range selection), `server/utils/posts-query.ts` (ORDER BY and country SQL), `server/utils/draft-rows.ts` (screened keyed draft selection) — and the page and endpoints only wire them up. That is the repo's established answer to `jobs.ts` and the Nuxt pages being unimportable from `node --test`.

**Tech Stack:** Nuxt 4 + Nuxt UI v4 (`UTable` = TanStack), Drizzle over better-sqlite3, Zod, `node --test` with Node 22 type stripping.

**Spec:** `docs/superpowers/specs/2026-10-01-posts-grid-design.md`

## Global Constraints

- **Before every task that edits `server/`**: `curl -s http://127.0.0.1:3939/api/job` must show every lane's `current` null and an empty `queue`. If not, stop and ask the owner. A server edit restarts Nitro's dev worker thread and **drops running and queued jobs** (measured 2026-10-01: one draft + 18 queued lost). `app/`, `shared/` files only the client imports, and `test/` are safe.
- Test-importable modules use **relative imports with the `.ts` extension** and raw better-sqlite3 SQL — never `~`/`#` aliases, never Drizzle, never anything that reaches `jobs.ts`, `sync.ts` or the drafter.
- **No backslash escapes in new source where avoidable** (`\b`, `\n`, `\uXXXX` have been mangled by file tools in this repo). Write word-boundary checks as character tests, not regexes. After any edit that does contain one, `grep -n` the line and confirm the bytes.
- Never write a literal phone-shaped number under `scraper/`, or any owner identity anywhere (`test/identity.test.ts`).
- Default view must be **byte-identical in behaviour** to today's: bare `/` = status Unprocessed, type Hiring, flags Unflagged, everything else Any, order flagged-last → score desc → posted desc.
- Table width at a 1440×950 viewport: `table.scrollWidth <= container.clientWidth`. Report 1280 too (it already overflowed there before this work; not a gate).
- `npm test`, `npm run typecheck` and `npx eslint <changed files>` pass at the end of every task. (`npm run lint` has one pre-existing failure in `test/gaps.test.ts`; do not count it, do not fix it here.)
- Commit per task on branch `posts-grid`, message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A country *exclude* must keep posts whose `location` is NULL** — `NULL NOT IN (...)` is NULL in SQL, which silently drops them. Pinned in Task 3.
2. **A bookmarked or hand-edited URL with junk** (`?sort=foo&page=-3&minScore=7&status=nope`) must render the default for each bad key, never a 400 or a blank table. Pinned in Task 6 (client) and Task 2 (`.catch` on the API).
3. **Bulk Draft over a selection that includes already-drafted or skipped posts** must leave those rows' verdicts untouched. Pinned in Task 4.
4. **Shift-click when the anchor row has left the page** (page change, refresh) must act as a plain single toggle, not select a phantom range. Pinned in Task 6.
5. **Sorting by Role or Posted with NULL titles / NULL `posted_at`** must put those rows last in *both* directions. Pinned in Task 2.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `shared/countries.ts` | modify | `countriesIn()`, filter-only city table, `NO_COUNTRY`, `locationMatches()` |
| `server/utils/posts-query.ts` | create | `orderSql()`, `countryClause()` — pure SQL text builders |
| `server/api/posts.get.ts` | modify | `sort`/`dir`/`country`/`countryMode` params, wire the builders |
| `server/api/posts/countries.get.ts` | create | country options + counts for the picker |
| `server/utils/draft-rows.ts` | create | `keyedDraftRows()`, `freshKeys()` |
| `server/utils/jobs.ts` | modify | `JobArgs.screened`, `manual` discriminator, keyed rows, enqueue dedupe |
| `server/api/run/draft.post.ts` | modify | accept `keys` (always screened) |
| `server/api/settings/excludes.post.ts` | modify | accept `needles[]`, one reflag |
| `shared/posts-view.ts` | create | view type, defaults, option lists, `parseView`, `viewQuery`, `apiQuery`, `activeChips`, `nextSort`, `rangeKeys` |
| `app/components/PostsHeaderCell.vue` | create | header label + sort button + ⏷ filter popover |
| `app/components/PostsBulkBar.vue` | create | bulk action buttons |
| `app/pages/index.vue` | modify | URL-backed state, header filters, chips, bulk Draft / Exclude, range select |
| `test/countries.test.ts`, `test/posts-query.test.ts`, `test/draft-rows.test.ts`, `test/posts-view.test.ts` | create | the pure modules |
| `CLAUDE.md`, the spec | modify | correct the HMR claim; document the grid, screened bulk mode, coverage number |

---

### Task 1: Country resolution for the filter

**Files:**
- Modify: `shared/countries.ts` (append after `nameFormsFor`)
- Test: `test/countries.test.ts` (create)

**Interfaces:**
- Produces: `countriesIn(location: string | null | undefined): string[]` (display names, deduped); `NO_COUNTRY = '(no country)'`; `locationMatches(location: string | null, picked: string[]): boolean`.

- [ ] **Step 1: Write the failing test** — `test/countries.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countriesIn, locationMatches, NO_COUNTRY, resolveCountry } from '../shared/countries.ts'

const name = (s: string) => resolveCountry(s)!.name

test('countriesIn: comma form, word inside prose, US state, bare city, multi-country, nothing', () => {
  assert.deepEqual(countriesIn('Cairo, Egypt'), [name('Egypt')])
  assert.deepEqual(countriesIn('Egypt (onsite 1 day / remote 4 days)'), [name('Egypt')])
  assert.deepEqual(countriesIn('Hybrid - Vietnam (Q2 Hybrid)'), [name('Vietnam')])
  assert.deepEqual(countriesIn('Charlotte, NC'), [name('USA')])
  assert.deepEqual(countriesIn('Houston, TX or Dallas, TX (Onsite)'), [name('USA')])
  assert.deepEqual(countriesIn('Bangalore'), [name('India')])
  assert.deepEqual(countriesIn('Pune / Bangalore'), [name('India')])
  assert.deepEqual(countriesIn('Dubai'), [name('UAE')])
  assert.deepEqual(countriesIn('Remote (Bulgaria / Romania / Poland)').sort(), [name('Bulgaria'), name('Poland'), name('Romania')].sort())
  assert.deepEqual(countriesIn('Hybrid (non-negotiable)'), [])
  assert.deepEqual(countriesIn('unknown'), [])
  assert.deepEqual(countriesIn(null), [])
})

test('countriesIn: a name inside a longer word is not a match', () => {
  // "Oman" sits inside "Romania" (r-OMAN-ia); a substring match would report both
  assert.ok(!countriesIn('Remote (Romania)').includes(name('Oman')))
})

test('every city in the filter table resolves to a real country', () => {
  for (const city of ['Bangalore', 'Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Mumbai', 'Noida', 'Gurugram',
    'Indore', 'Dubai', 'Abu Dhabi', 'Riyadh', 'Jeddah', 'Dammam', 'Cairo', 'Doha', 'Lahore', 'Amman']) {
    assert.equal(countriesIn(city).length, 1, city)
  }
})

test('locationMatches: a picked country, and NO_COUNTRY for what resolves to nothing', () => {
  assert.equal(locationMatches('Pune', [name('India')]), true)
  assert.equal(locationMatches('Pune', [name('Egypt')]), false)
  assert.equal(locationMatches(null, [NO_COUNTRY]), true)
  assert.equal(locationMatches('Remote', [NO_COUNTRY]), true)
  assert.equal(locationMatches('Pune', [NO_COUNTRY]), false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/countries.test.ts`
Expected: FAIL — `countriesIn` is not exported.

- [ ] **Step 3: Implement** — append to `shared/countries.ts`

```ts
/**
 * Bare city names, for the Posts view's country filter ONLY — measured 2026-10-01 as the largest share
 * of locations no country name resolves ("Bangalore", "Pune", "Dubai"). Never fed to withAliases() or
 * nameFormsFor(): those reach the scoring prompt and the pre-screen, and a city there would widen what
 * the owner configured as a country.
 * ponytail: a hand list of the measured top misses; a geocoder if the long tail starts to matter.
 */
const CITY_COUNTRY: Record<string, string> = {
  'bangalore': 'India', 'bengaluru': 'India', 'hyderabad': 'India', 'pune': 'India', 'chennai': 'India',
  'mumbai': 'India', 'noida': 'India', 'gurugram': 'India', 'gurgaon': 'India', 'indore': 'India',
  'delhi': 'India', 'kochi': 'India', 'ahmedabad': 'India', 'kolkata': 'India',
  'dubai': 'UAE', 'abu dhabi': 'UAE', 'sharjah': 'UAE',
  'riyadh': 'Saudi Arabia', 'jeddah': 'Saudi Arabia', 'dammam': 'Saudi Arabia', 'khobar': 'Saudi Arabia',
  'cairo': 'Egypt', 'giza': 'Egypt', 'alexandria': 'Egypt',
  'doha': 'Qatar', 'amman': 'Jordan',
  'lahore': 'Pakistan', 'karachi': 'Pakistan', 'islamabad': 'Pakistan'
}

/** ponytail: "Atlanta, Georgia" resolves to the country Georgia; full US state names are not mapped. */
const US_STATES = new Set(('AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT '
  + 'NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY').split(' '))

// A character test rather than a regex word boundary: `\b` is ASCII-only, and backslashes have been
// mangled by the file tools in this repo. A letter is anything with case, plus digits.
const isWordChar = (ch: string | undefined) =>
  !!ch && (ch.toLowerCase() !== ch.toUpperCase() || (ch >= '0' && ch <= '9'))

function hasWord(hay: string, needle: string): boolean {
  const h = hay.toLowerCase()
  const n = needle.toLowerCase()
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) {
    if (!isWordChar(h[i - 1]) && !isWordChar(h[i + n.length])) return true
  }
  return false
}

/**
 * Every country a free-text location names — for filtering, where a miss shows as "no country" rather
 * than as a wrong answer. Broader than homeCountryOf(), which must fail open for the pre-screen.
 */
export function countriesIn(location: string | null | undefined): string[] {
  const l = (location ?? '').trim()
  if (!l) return []
  const out = new Set<string>()
  const home = homeCountryOf(l)
  if (home) out.add(home.name)
  for (const c of COUNTRIES) {
    if ([c.name, ...c.aliases].some(f => hasWord(l, f))) out.add(c.name)
  }
  for (const [city, country] of Object.entries(CITY_COUNTRY)) {
    const c = hasWord(l, city) ? resolveCountry(country) : undefined
    if (c) out.add(c.name)
  }
  if (l.split(',').slice(1).some(seg => US_STATES.has(seg.trim().split(' ')[0] ?? ''))) {
    const us = resolveCountry('USA')
    if (us) out.add(us.name)
  }
  return [...out]
}

/** The picker's entry for locations that resolve to no country: empty, "unknown", "Remote", or a miss. */
export const NO_COUNTRY = '(no country)'

export function locationMatches(location: string | null, picked: string[]): boolean {
  const cs = countriesIn(location)
  return picked.some(p => (p === NO_COUNTRY ? cs.length === 0 : cs.includes(p)))
}
```

If `Oman` is matched inside `Romania` the test fails — `hasWord` prevents it. If any city maps to a country name `resolveCountry` does not know, the city test fails; fix the value, not the test.

- [ ] **Step 4: Run tests**

Run: `node --test test/countries.test.ts && npm test`
Expected: all PASS.

- [ ] **Step 5: Measure coverage over the live posts and record it**

```bash
sqlite3 -readonly -json data/jobfinder.db "select location l, count(*) n from posts where dismissed_at is null group by 1" > "$TEMP/locs.json"
cat > "$TEMP/cov.ts" <<'EOF'
import { readFileSync } from 'node:fs'
import { countriesIn } from 'file:///F:/Work/job-finder/shared/countries.ts'
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { l: string | null, n: number }[]
let withLoc = 0, hit = 0
for (const r of rows) {
  const l = (r.l ?? '').trim().toLowerCase()
  if (!l || l === 'unknown' || l === 'remote') continue
  withLoc += r.n
  if (countriesIn(r.l).length) hit += r.n
}
console.log({ withLoc, hit, pct: Math.round(100 * hit / withLoc) })
EOF
node "$TEMP/cov.ts" "$TEMP/locs.json"
```

Expected: `pct` above 77 (the pre-city-table figure). Write the number into the spec's §4 table as a new row "+ filter-only city table". Read-only on the database.

- [ ] **Step 6: Commit**

```bash
git add shared/countries.ts test/countries.test.ts docs/superpowers/specs/2026-10-01-posts-grid-design.md
git commit -m "Country resolution for the Posts filter: countriesIn, filter-only city table"
```

---

### Task 2: Server-side sort

**Files:**
- Create: `server/utils/posts-query.ts`
- Modify: `server/api/posts.get.ts` (query schema; `.orderBy(...)`)
- Test: `test/posts-query.test.ts` (create)

**Interfaces:**
- Produces: `SORTS = ['default', 'score', 'title', 'posted', 'added'] as const`, `type Sort`, `type Dir = 'asc' | 'desc'`, `orderSql(sort: Sort, dir: Dir): string` — a comma-separated ORDER BY list over `posts.*` columns, built only from allowlisted literals (safe for `sql.raw`).

- [ ] **Step 1: Server-edit gate** — run `curl -s http://127.0.0.1:3939/api/job`; continue only if every lane's `current` is null and `queue` is `[]`.

- [ ] **Step 2: Write the failing test** — `test/posts-query.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { orderSql } from '../server/utils/posts-query.ts'

// A minimal posts table: only the columns the ORDER BY reads.
function seed() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE posts (key TEXT PRIMARY KEY, score INTEGER, title TEXT, posted_at INTEGER,
    scraped_at INTEGER, flags TEXT NOT NULL DEFAULT '[]')`)
  const ins = db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?)')
  ins.run('a', 8, 'Backend', 300, 10, '[]')
  ins.run('b', 6, null, null, 30, '[]')
  ins.run('c', 9, 'Architect', 100, 20, '["junior"]') // flagged
  ins.run('d', 7, 'devops', 200, 40, '[]')
  return db
}
const keys = (db: Database.Database, order: string) =>
  (db.prepare(`SELECT key FROM posts ORDER BY ${order}`).all() as { key: string }[]).map(r => r.key)

test('default keeps today\'s order: flagged last, then score desc', () => {
  assert.deepEqual(keys(seed(), orderSql('default', 'desc')), ['a', 'd', 'b', 'c'])
})

test('flagged rows stay last under every explicit sort', () => {
  for (const s of ['score', 'title', 'posted', 'added'] as const) {
    for (const d of ['asc', 'desc'] as const) assert.equal(keys(seed(), orderSql(s, d)).at(-1), 'c', `${s} ${d}`)
  }
})

test('NULLs sort last in both directions', () => {
  assert.deepEqual(keys(seed(), orderSql('posted', 'desc')), ['a', 'd', 'b', 'c'])
  assert.deepEqual(keys(seed(), orderSql('posted', 'asc')), ['d', 'a', 'b', 'c'])
  assert.deepEqual(keys(seed(), orderSql('title', 'asc')), ['a', 'd', 'b', 'c']) // case-folded: Backend < devops
  assert.deepEqual(keys(seed(), orderSql('title', 'desc')), ['d', 'a', 'b', 'c'])
})

test('added sorts by scraped_at', () => {
  assert.deepEqual(keys(seed(), orderSql('added', 'desc')), ['d', 'b', 'a', 'c'])
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/posts-query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `server/utils/posts-query.ts`

```ts
// Pure SQL-text builders for /api/posts, kept out of the handler so `node --test` can run them against
// a real SQLite: the handler imports Drizzle and the server's db, which no test here can load.

export const SORTS = ['default', 'score', 'title', 'posted', 'added'] as const
export type Sort = typeof SORTS[number]
export type Dir = 'asc' | 'desc'

const COLUMN: Record<Exclude<Sort, 'default'>, string> = {
  score: 'posts.score',
  title: 'lower(posts.title)',
  posted: 'posts.posted_at',
  added: 'posts.scraped_at'
}

/**
 * ORDER BY for the Posts view. Flagged-last is the first key under every sort: the drafter queue
 * excludes flagged posts outright, so floating them up would mix undraftable rows into a triage pass.
 * NULLs go last in both directions (a pasted post has no posted_at). `posts.key` makes paging stable.
 * Only allowlisted literals are interpolated, which is what makes this safe for sql.raw().
 */
export function orderSql(sort: Sort, dir: Dir): string {
  const flaggedLast = 'json_array_length(posts.flags) > 0'
  if (sort === 'default') return `${flaggedLast}, posts.score DESC, posts.posted_at DESC, posts.key`
  const col = COLUMN[sort]
  return `${flaggedLast}, ${col} IS NULL, ${col} ${dir === 'asc' ? 'ASC' : 'DESC'}, posts.key`
}
```

- [ ] **Step 5: Wire it into `server/api/posts.get.ts`**

Add to the imports:

```ts
import { orderSql, SORTS } from '../utils/posts-query'
```

Add to the `query` object, after `added`:

```ts
  sort: z.enum(SORTS).catch('default'),
  dir: z.enum(['asc', 'desc']).catch('desc'),
```

(`.catch`, not `.default`: a junk value from a bookmarked URL falls back instead of answering 400 — Review Focus 2.) Replace the `.orderBy(...)` line and the comment above it with:

```ts
    // flagged last under every sort — see orderSql
    .orderBy(sql.raw(orderSql(p.sort, p.dir)))
```

- [ ] **Step 6: Run tests, typecheck, and a live check**

Run: `npm test && npm run typecheck`
Then: `curl -s "http://127.0.0.1:3939/api/posts?status=all&sort=posted&dir=asc&limit=3" | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(j.rows.map(r=>r.postedAt))"`
Expected: ascending dates. And `curl -s "http://127.0.0.1:3939/api/posts?sort=foo&limit=1" -o /dev/null -w "%{http_code}"` → `200`.

- [ ] **Step 7: Commit**

```bash
git add server/utils/posts-query.ts server/api/posts.get.ts test/posts-query.test.ts
git commit -m "Posts API: allowlisted sort and dir, flagged last under every sort"
```

---

### Task 3: Country filter on the API, and the picker's options

**Files:**
- Modify: `server/utils/posts-query.ts` (append), `server/api/posts.get.ts`
- Create: `server/api/posts/countries.get.ts`
- Test: `test/posts-query.test.ts` (append)

**Interfaces:**
- Consumes: `countriesIn`, `locationMatches`, `NO_COUNTRY` from Task 1.
- Produces: `countryClause(locations: (string | null)[], picked: string[], mode: 'include' | 'exclude'): { sql: string, param: string } | null` — `sql` contains exactly one `?`, bound to `param` (a JSON array). `GET /api/posts/countries` → `{ name: string, count: number }[]`, most frequent first, `NO_COUNTRY` last.

- [ ] **Step 1: Server-edit gate** — as in Task 2, Step 1.

- [ ] **Step 2: Append the failing tests** to `test/posts-query.test.ts`

```ts
import { countryClause } from '../server/utils/posts-query.ts'
import { NO_COUNTRY } from '../shared/countries.ts'

function seedLoc() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE posts (key TEXT PRIMARY KEY, location TEXT)')
  const ins = db.prepare('INSERT INTO posts VALUES (?, ?)')
  ins.run('in1', 'Pune'); ins.run('in2', 'Bangalore, India'); ins.run('eg', 'Cairo, Egypt')
  ins.run('none', null); ins.run('remote', 'Remote')
  return db
}
const LOCS = ['Pune', 'Bangalore, India', 'Cairo, Egypt', null, 'Remote']
const run = (db: Database.Database, c: { sql: string, param: string } | null) =>
  (db.prepare(`SELECT key FROM posts${c ? ` WHERE ${c.sql}` : ''} ORDER BY key`).all(...(c ? [c.param] : [])) as { key: string }[]).map(r => r.key)

test('country include picks every location that names the country', () => {
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, ['India'], 'include')), ['in1', 'in2'])
})

test('country exclude keeps NULL locations — NULL NOT IN (...) would drop them', () => {
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, ['India'], 'exclude')), ['eg', 'none', 'remote'])
})

test('NO_COUNTRY covers NULL and unresolved, in both modes', () => {
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, [NO_COUNTRY], 'include')), ['none', 'remote'])
  assert.deepEqual(run(seedLoc(), countryClause(LOCS, [NO_COUNTRY], 'exclude')), ['eg', 'in1', 'in2'])
})

test('no countries picked means no clause', () => {
  assert.equal(countryClause(LOCS, [], 'exclude'), null)
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/posts-query.test.ts`
Expected: FAIL — `countryClause` is not exported.

- [ ] **Step 4: Implement** — append to `server/utils/posts-query.ts`

```ts
import { locationMatches } from '../../shared/countries.ts'

/**
 * WHERE text for the country filter. `location` is free text from the scoring model, so the mapping to
 * countries runs in JS over the distinct values (~440) and the result is bound as one JSON array — one
 * placeholder however many locations match. NULL needs its own branch both ways: `NULL IN (...)` and
 * `NULL NOT IN (...)` are both NULL, so an exclude would otherwise silently drop every unlocated post.
 */
export function countryClause(
  locations: (string | null)[],
  picked: string[],
  mode: 'include' | 'exclude'
): { sql: string, param: string } | null {
  if (!picked.length) return null
  const hit = locations.filter(l => l !== null && locationMatches(l, picked)) as string[]
  const nullHit = locationMatches(null, picked)
  const inList = 'posts.location IN (SELECT value FROM json_each(?))'
  const sql = mode === 'include'
    ? `(${inList}${nullHit ? ' OR posts.location IS NULL' : ''})`
    : nullHit
      ? `(posts.location IS NOT NULL AND NOT ${inList})`
      : `(posts.location IS NULL OR NOT ${inList})`
  return { sql, param: JSON.stringify(hit) }
}
```

(Move the new `import` to the top of the file with the others.)

- [ ] **Step 5: Wire into `server/api/posts.get.ts`**

Imports:

```ts
import { countryClause, orderSql, SORTS } from '../utils/posts-query'
```

Add to `query`:

```ts
  /** repeatable: ?country=India&country=Egypt — names as countriesIn() returns them, or NO_COUNTRY */
  country: z.union([z.string(), z.array(z.string())]).optional()
    .transform(v => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(s => s.trim()).filter(Boolean).slice(0, 50)),
  countryMode: z.enum(['include', 'exclude']).catch('exclude'),
```

At the top of the handler body, after `const p = ...`:

```ts
  const locs = p.country.length
    ? (await db.selectDistinct({ l: posts.location }).from(posts)).map(r => r.l)
    : []
  const cc = countryClause(locs, p.country, p.countryMode)
  const [before, after] = cc ? cc.sql.split('?') : ['', '']
```

And in the `where` array, after the `added` line:

```ts
    cc ? sql`${sql.raw(before!)}${cc.param}${sql.raw(after!)}` : undefined,
```

`before`/`after` come only from `countryClause`'s fixed text; the location list travels as the bound parameter.

- [ ] **Step 6: Create `server/api/posts/countries.get.ts`**

```ts
import { isNull, sql } from 'drizzle-orm'
import { countriesIn, NO_COUNTRY } from '../../../shared/countries'
import { posts } from '../../db/schema'
import { db } from '../../utils/db'

/** The country picker's options: every country the live posts' locations name, with counts. */
export default defineEventHandler(async () => {
  const rows = await db
    .select({ l: posts.location, n: sql<number>`count(*)` })
    .from(posts)
    .where(isNull(posts.dismissedAt))
    .groupBy(posts.location)
  const counts = new Map<string, number>()
  let none = 0
  for (const r of rows) {
    const cs = countriesIn(r.l)
    if (!cs.length) none += r.n
    // a multi-country location counts toward each country it names
    for (const c of cs) counts.set(c, (counts.get(c) ?? 0) + r.n)
  }
  return [
    ...[...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    { name: NO_COUNTRY, count: none }
  ]
})
```

- [ ] **Step 7: Run tests, typecheck, live checks**

Run: `npm test && npm run typecheck`
Then:
```bash
curl -s http://127.0.0.1:3939/api/posts/countries | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).slice(0,5))"
curl -s "http://127.0.0.1:3939/api/posts?status=all&limit=1" | node -e "console.log('all',JSON.parse(require('fs').readFileSync(0)).total)"
curl -s "http://127.0.0.1:3939/api/posts?status=all&limit=1&country=India&countryMode=exclude" | node -e "console.log('not India',JSON.parse(require('fs').readFileSync(0)).total)"
curl -s "http://127.0.0.1:3939/api/posts?status=all&limit=1&country=India&countryMode=include" | node -e "console.log('India',JSON.parse(require('fs').readFileSync(0)).total)"
```
Expected: India first or near the top; `India + not India == all`.

- [ ] **Step 8: Commit**

```bash
git add server/utils/posts-query.ts server/api/posts.get.ts server/api/posts/countries.get.ts test/posts-query.test.ts
git commit -m "Posts API: country include/exclude filter and the picker's country counts"
```

---

### Task 4: Screened bulk Draft on the server

**Files:**
- Create: `server/utils/draft-rows.ts`
- Modify: `server/utils/jobs.ts` (`JobArgs`, `enqueue`, `runDraftJob` keyed query + `manual`), `server/api/run/draft.post.ts`
- Test: `test/draft-rows.test.ts` (create)

**Interfaces:**
- Produces: `keyedDraftRows(db: Database.Database, keys: string[], screened: boolean): unknown[]`; `freshKeys(keys: string[], queued: { key?: string, keys?: string[] }[], running: string[]): string[]`. `JobArgs.screened?: boolean`. `POST /api/run/draft` body `{ keys: string[] }` (1-100 sha1) → always enqueued screened.

- [ ] **Step 1: Server-edit gate** — as in Task 2, Step 1.

- [ ] **Step 2: Write the failing test** — `test/draft-rows.test.ts`

```ts
// Bulk Draft runs "screened": the drafter may skip, and the skip is recorded. persist() does not guard
// against rewriting a `drafted` verdict as `skipped` (CLAUDE.md, "A skip must never downgrade a drafted
// verdict"); the batch queue never reaches that because it selects `a.key IS NULL`, so the screened
// keyed path must select the same way. This file pins that.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { freshKeys, keyedDraftRows } from '../server/utils/draft-rows.ts'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'

let dir: string
let db: Database.Database
const K = (c: string) => c.repeat(40)

const post = (key: string): ScraperRecord => ({
  op: 'post', key, searchTerm: 't', author: 'R', authorUrl: 'https://www.linkedin.com/in/r', postUrl: null,
  postedAge: '1d', postedAt: '2026-09-30T09:00:00.000Z', postType: 'hiring', title: 'Engineer', company: 'Acme',
  location: 'Riyadh', remote: false, inScope: true, emails: ['hr@acme.sa'], links: [], phones: [], refIds: [],
  channels: ['email'], score: 7, reason: 'r', text: 'hiring, send CV to hr@acme.sa', flags: []
} as ScraperRecord)

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-draftrows-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
  for (const c of ['a', 'b', 'c', 'd']) applyRecord(db, post(K(c)))
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'drafted', 'named in application')`).run(K('b'))
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'skipped', 'not hiring')`).run(K('c'))
  db.prepare('UPDATE posts SET dismissed_at = unixepoch() WHERE key = ?').run(K('d'))
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

const keysOf = (rows: unknown[]) => (rows as { key: string }[]).map(r => r.key).sort()

test('screened: only posts with no verdict — drafted and skipped rows are left alone', () => {
  assert.deepEqual(keysOf(keyedDraftRows(db, [K('a'), K('b'), K('c'), K('d')], true)), [K('a')])
})

test('control: hand-picked (the row button) still reaches a skipped post, so it can be overruled', () => {
  assert.deepEqual(keysOf(keyedDraftRows(db, [K('a'), K('b'), K('c'), K('d')], false)), [K('a'), K('b'), K('c')])
})

test('dismissed posts are never drafted, in either mode', () => {
  assert.deepEqual(keysOf(keyedDraftRows(db, [K('d')], false)), [])
})

test('freshKeys drops keys already queued (single or bulk) or running', () => {
  assert.deepEqual(
    freshKeys([K('a'), K('b'), K('c'), K('d')], [{ key: K('a') }, { keys: [K('b')] }], [K('c')]),
    [K('d')]
  )
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/draft-rows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `server/utils/draft-rows.ts`

```ts
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
```

- [ ] **Step 5: Run the new test**

Run: `node --test test/draft-rows.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `server/utils/jobs.ts`**

1. Import: add `import { freshKeys, keyedDraftRows } from './draft-rows'` beside the other `./` imports.
2. `JobArgs` — after `n?: number`:

```ts
  /** draft lane, with `keys`: bulk Draft from the Posts view — the drafter may skip, and it is recorded */
  screened?: boolean
```

3. `enqueue` — the first statement in the body, before the existing single-`key` check:

```ts
  // A bulk draft keeps only the keys not already waiting or running; pump() never coalesces a `keys`
  // item with single-`key` ones, so screened and hand-picked posts cannot share a session.
  if (kind === 'draft' && args.keys) {
    const keys = freshKeys(args.keys, queue.filter(q => q.kind === 'draft').map(q => q.args), lanes.draft.current?.args?.keys ?? [])
    if (!keys.length) return null
    args = { ...args, keys }
  }
```

4. `runDraftJob` — replace `const manual = !!args.keys?.length` with:

```ts
    // A bulk draft from the Posts view carries `screened`, and is triaged like the batch run.
    const manual = !!args.keys?.length && !args.screened
```

Update the comment above it: the discriminator is single-post keys **without** `screened`.

5. Replace the keyed branch of the `rows` ternary (the `db.prepare(... WHERE p.key IN ...).all(...args.keys)` expression and its dismissed/applied comment) with:

```ts
      ? keyedDraftRows(db, args.keys, !!args.screened)
```

6. Right after the `rows` assignment, before `if (!rows.length)`:

```ts
    if (args.screened && args.keys && rows.length < args.keys.length) {
      push(`${args.keys.length - rows.length} selected post(s) left out: already drafted, skipped, dismissed or applied`)
    }
```

- [ ] **Step 7: `server/api/run/draft.post.ts`**

```ts
const body = z.object({
  // a single post (the Posts view's Draft button), a bulk selection, or the top N unprocessed
  key: z.string().regex(/^[0-9a-f]{40}$/, 'key must be a sha1').optional(),
  keys: z.array(z.string().regex(/^[0-9a-f]{40}$/, 'key must be a sha1')).min(1).max(100).optional(),
  n: z.number().int().min(1).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)
  // a bulk selection is always screened: hand-picked bulk is not a mode the UI offers (spec §3)
  const item = enqueue('draft', a.keys ? { keys: a.keys, screened: true } : a.key ? { key: a.key } : { n: a.n ?? 10 })
  setResponseStatus(event, item ? 202 : 200)
  // a repeat request for posts already queued or running is a no-op, not a second session
  return { ...stateView(), queued: !!item, note: item ? undefined : 'already queued or running' }
})
```

- [ ] **Step 8: Full tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — including `test/manual-draft.test.ts`, whose source assertion `/const manual = !!args\.keys\?\.length/` still matches the new line's prefix. Then a body-validation check that writes nothing: `curl -s -X POST http://127.0.0.1:3939/api/run/draft -H "content-type: application/json" -d '{"keys":["nope"]}' -o /dev/null -w "%{http_code}"` → `400`.

- [ ] **Step 9: Commit**

```bash
git add server/utils/draft-rows.ts server/utils/jobs.ts server/api/run/draft.post.ts test/draft-rows.test.ts
git commit -m "Bulk Draft runs screened: only unprocessed posts, skips recorded, keys deduped"
```

---

### Task 5: Excludes endpoint takes a list

**Files:**
- Modify: `server/api/settings/excludes.post.ts`
- Test: `test/invariants.test.ts` (append one source-level test)

**Interfaces:**
- Produces: `POST /api/settings/excludes` accepts `{ needle }` or `{ needles: string[] }` (1-50, each 2-80 chars trimmed) → `{ excludes }`, one reflag enqueued.

- [ ] **Step 1: Server-edit gate** — as in Task 2, Step 1.

- [ ] **Step 2: Write the failing test** — append to `test/invariants.test.ts` (it already imports `readFileSync`, `assert`, `test`; add whatever is missing)

```ts
test('the excludes endpoint takes a list and still queues exactly one reflag', () => {
  // Source-level: the handler is a Nitro event handler no test here can import.
  const src = readFileSync('server/api/settings/excludes.post.ts', 'utf8')
  assert.match(src, /needles:/, 'a bulk Exclude posts several names in one request')
  assert.equal(src.split("enqueue('reflag')").length - 1, 1, 'one reflag per request, however many needles')
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/invariants.test.ts`
Expected: FAIL on `needles:`.

- [ ] **Step 4: Implement**

```ts
const needle = z.string().trim().min(2).max(80)
const body = z.object({
  // the same bounds as settingsSchema.excludes, so a bad needle fails here with a readable message
  // instead of inside parseSettings, where the error is a field path the dialog cannot render
  needle: needle.optional(),
  // the Posts view's bulk Exclude: every company and recruiter of the selection, in one save
  needles: z.array(needle).min(1).max(50).optional()
}).refine(b => b.needle || b.needles, 'needle or needles is required')

export default defineEventHandler(async (event) => {
  const b = await readValidatedBody(event, body.parse)
  const excludes = [...readConfigLoose().excludes, ...(b.needles ?? [b.needle!])]
  const saved = patchConfig({ excludes })
  enqueue('reflag') // the list changed by definition; server-side for the reason config.put.ts gives
  return { excludes: saved.excludes }
})
```

- [ ] **Step 5: Tests, typecheck, a non-writing live check**

Run: `npm test && npm run typecheck`
Then: `curl -s -X POST http://127.0.0.1:3939/api/settings/excludes -H "content-type: application/json" -d '{"needles":["x"]}' -o /dev/null -w "%{http_code}"` → `400` (too short; nothing saved). Do **not** send a valid body: it would write the owner's real settings.

- [ ] **Step 6: Commit**

```bash
git add server/api/settings/excludes.post.ts test/invariants.test.ts
git commit -m "Excludes endpoint accepts a list of needles, one reflag per request"
```

---

### Task 6: View state module

**Files:**
- Create: `shared/posts-view.ts`
- Test: `test/posts-view.test.ts` (create)

**Interfaces:**
- Consumes: `SORTS`, `Sort`, `Dir` from `server/utils/posts-query.ts` — **re-declare** them here instead of importing (a `shared/` file the browser bundles must not import `server/`); a test pins that the two lists match.
- Produces:
  - `type PostsView = { q: string, status: Status, type: PostType, flags: Flags, scope: Scope, channel: Channel, minScore: number, posted: number, added: number, country: string[], countryMode: 'include' | 'exclude', sort: Sort, dir: Dir, page: number }`
  - `DEFAULT_VIEW: PostsView`, `OPTIONS` (label/value lists per enum key), `FIELD_LABEL`
  - `parseView(query: Record<string, unknown>): PostsView`
  - `viewQuery(v: PostsView): Record<string, string | string[]>` — non-default keys only, for the URL
  - `apiQuery(v: PostsView, pageSize: number): Record<string, string | number | string[]>` — every key the API reads, plus `limit`/`offset`
  - `activeChips(v: PostsView): { key: keyof PostsView, label: string }[]`
  - `nextSort(cur: { sort: Sort, dir: Dir }, col: Exclude<Sort, 'default'>): { sort: Sort, dir: Dir }`
  - `rangeKeys(keys: string[], anchor: string | null, target: string): string[]`

- [ ] **Step 1: Write the failing test** — `test/posts-view.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SORTS as SERVER_SORTS } from '../server/utils/posts-query.ts'
import { activeChips, apiQuery, DEFAULT_VIEW, nextSort, parseView, rangeKeys, SORTS, viewQuery } from '../shared/posts-view.ts'

test('the client sort list matches the server allowlist', () => {
  assert.deepEqual([...SORTS], [...SERVER_SORTS])
})

test('a bare URL is the default view, and the default view writes an empty query', () => {
  assert.deepEqual(parseView({}), DEFAULT_VIEW)
  assert.deepEqual(viewQuery(DEFAULT_VIEW), {})
})

test('junk in the URL falls back per key, never throws', () => {
  const v = parseView({ sort: 'foo', dir: 'up', page: '-3', minScore: '7', status: 'nope', posted: 'x', country: '', q: '  rust  ' })
  assert.equal(v.sort, 'default')
  assert.equal(v.dir, 'desc')
  assert.equal(v.page, 1)
  assert.equal(v.minScore, 0) // only 0 / 6 / 8 are offered
  assert.equal(v.status, 'unprocessed')
  assert.equal(v.posted, 0)
  assert.deepEqual(v.country, [])
  assert.equal(v.q, 'rust')
})

test('round trip: every non-default value survives URL → view → URL', () => {
  const v = { ...DEFAULT_VIEW, status: 'drafted' as const, minScore: 6, posted: 7, country: ['India', 'Egypt'], countryMode: 'include' as const, sort: 'posted' as const, dir: 'asc' as const, page: 3 }
  assert.deepEqual(parseView(viewQuery(v)), v)
})

test('a single country in the URL arrives as a string, not an array', () => {
  assert.deepEqual(parseView({ country: 'India' }).country, ['India'])
})

test('apiQuery carries paging and every filter the API reads', () => {
  const q = apiQuery({ ...DEFAULT_VIEW, page: 2 }, 100)
  assert.equal(q.offset, 100)
  assert.equal(q.limit, 100)
  assert.equal(q.status, 'unprocessed')
  assert.equal('page' in q, false)
})

test('chips list only what differs from the default', () => {
  assert.deepEqual(activeChips(DEFAULT_VIEW), [])
  const chips = activeChips({ ...DEFAULT_VIEW, minScore: 6, country: ['India'], countryMode: 'exclude' })
  assert.deepEqual(chips.map(c => c.key), ['minScore', 'country'])
  assert.match(chips[1]!.label, /not India/)
})

test('sort cycles desc → asc → default, and a new column starts at desc', () => {
  let s = nextSort({ sort: 'default', dir: 'desc' }, 'posted')
  assert.deepEqual(s, { sort: 'posted', dir: 'desc' })
  s = nextSort(s, 'posted')
  assert.deepEqual(s, { sort: 'posted', dir: 'asc' })
  s = nextSort(s, 'posted')
  assert.deepEqual(s, { sort: 'default', dir: 'desc' })
  assert.deepEqual(nextSort({ sort: 'score', dir: 'asc' }, 'added'), { sort: 'added', dir: 'desc' })
})

test('rangeKeys: the inclusive span either direction; a missing anchor is a single toggle', () => {
  const keys = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(rangeKeys(keys, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeKeys(keys, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(rangeKeys(keys, 'gone', 'c'), ['c']) // anchor left the page
  assert.deepEqual(rangeKeys(keys, null, 'c'), ['c'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/posts-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `shared/posts-view.ts`

```ts
// The Posts view's state as a pure value: what the URL holds, what the API is asked, which filters show
// as chips. Kept out of index.vue so `node --test` can pin it (there is no Vue test setup here), the same
// reason shared/paste-poll.ts exists. Must not import server/: the browser bundles this file.

export const SORTS = ['default', 'score', 'title', 'posted', 'added'] as const // = server/utils/posts-query.ts
export type Sort = typeof SORTS[number]
export type Dir = 'asc' | 'desc'

type Opt<T> = { label: string, value: T }
const opts = <T extends string | number>(...o: [string, T][]): Opt<T>[] => o.map(([label, value]) => ({ label, value }))
const RANGE = opts<number>(['Any time', 0], ['24h', 1], ['3 days', 3], ['This week', 7], ['This month', 30])

export const OPTIONS = {
  status: opts(['Unprocessed', 'unprocessed'], ['All active', 'all'], ['Drafted', 'drafted'], ['Skipped', 'skipped'],
    ['Applied by hand', 'applied'], ['Dismissed', 'dismissed']),
  type: opts(['Hiring only', 'hiring'], ['Any post type', 'all'], ['Not hiring', 'other']),
  flags: opts(['Unflagged', 'clean'], ['Any flags', 'all'], ['Flagged only', 'flagged'], ['Excluded', 'excluded']),
  scope: opts(['Anywhere', 'all'], ['In scope', 'in-scope'], ['Remote', 'remote']),
  channel: opts(['Any contact', 'all'], ['By email', 'email'], ['By link', 'link'], ['By phone', 'phone']),
  minScore: opts<number>(['Any score', 0], ['6+', 6], ['8+', 8]),
  posted: RANGE,
  added: RANGE
} as const

type OptValue<K extends keyof typeof OPTIONS> = typeof OPTIONS[K][number]['value']
export type Status = OptValue<'status'>
export type PostType = OptValue<'type'>
export type Flags = OptValue<'flags'>
export type Scope = OptValue<'scope'>
export type Channel = OptValue<'channel'>

export interface PostsView {
  q: string
  status: Status
  type: PostType
  flags: Flags
  scope: Scope
  channel: Channel
  minScore: number
  posted: number
  added: number
  country: string[]
  countryMode: 'include' | 'exclude'
  sort: Sort
  dir: Dir
  page: number
}

/** Today's defaults — a bare `/` must look exactly as it did before the grid. */
export const DEFAULT_VIEW: PostsView = {
  q: '', status: 'unprocessed', type: 'hiring', flags: 'clean', scope: 'all', channel: 'all',
  minScore: 0, posted: 0, added: 0, country: [], countryMode: 'exclude', sort: 'default', dir: 'desc', page: 1
}

export const FIELD_LABEL: Record<keyof typeof OPTIONS, string> = {
  status: 'Status', type: 'Type', flags: 'Flags', scope: 'Where', channel: 'Contact', minScore: 'Score',
  posted: 'Posted', added: 'Added'
}

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v)
const str = (v: unknown) => (typeof first(v) === 'string' ? (first(v) as string).trim() : '')

function pickOpt<K extends keyof typeof OPTIONS>(key: K, raw: unknown): typeof OPTIONS[K][number]['value'] {
  const s = str(raw)
  const hit = (OPTIONS[key] as readonly Opt<string | number>[]).find(o => String(o.value) === s)
  return (hit ? hit.value : DEFAULT_VIEW[key]) as typeof OPTIONS[K][number]['value']
}

/** URL query → view. Every bad or missing key falls back to its default on its own. */
export function parseView(query: Record<string, unknown>): PostsView {
  const page = Number.parseInt(str(query.page), 10)
  const sort = str(query.sort)
  const country = (Array.isArray(query.country) ? query.country : [query.country])
    .filter((c): c is string => typeof c === 'string').map(c => c.trim()).filter(Boolean)
  return {
    q: str(query.q),
    status: pickOpt('status', query.status),
    type: pickOpt('type', query.type),
    flags: pickOpt('flags', query.flags),
    scope: pickOpt('scope', query.scope),
    channel: pickOpt('channel', query.channel),
    minScore: pickOpt('minScore', query.minScore),
    posted: pickOpt('posted', query.posted),
    added: pickOpt('added', query.added),
    country,
    countryMode: str(query.countryMode) === 'include' ? 'include' : 'exclude',
    sort: (SORTS as readonly string[]).includes(sort) ? sort as Sort : 'default',
    dir: str(query.dir) === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page >= 1 ? page : 1
  }
}

/** View → URL query: only what differs from the default, so a default view is a bare `/`. */
export function viewQuery(v: PostsView): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const k of Object.keys(DEFAULT_VIEW) as (keyof PostsView)[]) {
    if (k === 'country') {
      if (v.country.length) out.country = v.country
      continue
    }
    if (v[k] !== DEFAULT_VIEW[k]) out[k] = String(v[k])
  }
  if (!v.country.length) delete out.countryMode
  return out
}

/** View → /api/posts query: every filter, paging as limit/offset. */
export function apiQuery(v: PostsView, pageSize: number): Record<string, string | number | string[]> {
  const { page, ...rest } = v
  return { ...rest, limit: pageSize, offset: (page - 1) * pageSize }
}

/** The filters that differ from the default, labelled for the chip row. Search and sort are not chips. */
export function activeChips(v: PostsView): { key: keyof PostsView, label: string }[] {
  const out: { key: keyof PostsView, label: string }[] = []
  for (const k of Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]) {
    if (v[k] === DEFAULT_VIEW[k]) continue
    const o = (OPTIONS[k] as readonly Opt<string | number>[]).find(x => x.value === v[k])
    out.push({ key: k, label: `${FIELD_LABEL[k]}: ${o?.label ?? String(v[k])}` })
  }
  if (v.country.length) {
    out.push({ key: 'country', label: `Country: ${v.countryMode === 'exclude' ? 'not ' : ''}${v.country.join(', ')}` })
  }
  return out
}

/** Header click: a new column starts descending; the same column goes desc → asc → back to default. */
export function nextSort(cur: { sort: Sort, dir: Dir }, col: Exclude<Sort, 'default'>): { sort: Sort, dir: Dir } {
  if (cur.sort !== col) return { sort: col, dir: 'desc' }
  return cur.dir === 'desc' ? { sort: col, dir: 'asc' } : { sort: 'default', dir: 'desc' }
}

/** Shift-click: every key from the anchor to the target, inclusive. An anchor no longer on the page is ignored. */
export function rangeKeys(keys: string[], anchor: string | null, target: string): string[] {
  const a = anchor ? keys.indexOf(anchor) : -1
  const t = keys.indexOf(target)
  if (a < 0 || t < 0) return [target]
  return keys.slice(Math.min(a, t), Math.max(a, t) + 1)
}
```

Chips come out in `OPTIONS` key order, then country — the order the test expects.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/posts-view.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/posts-view.ts test/posts-view.test.ts
git commit -m "Posts view state as a pure module: URL round trip, chips, sort cycle, range select"
```

---

### Task 7: URL-backed state and sortable, filterable headers

**Files:**
- Create: `app/components/PostsHeaderCell.vue`
- Modify: `app/pages/index.vue` (filter refs → URL view; `useFetch` query; filter bar → search + chips + Reset; column headers)

**Interfaces:**
- Consumes: everything from Task 6; `GET /api/posts/countries` from Task 3.
- Produces: `PostsHeaderCell` props `{ label: string, sortCol?: 'score' | 'title' | 'posted' | 'added', sort: Sort, dir: Dir, active: boolean }`, emits `sort`, default slot = the filter popover body.

- [ ] **Step 1: Create `app/components/PostsHeaderCell.vue`**

```vue
<script setup lang="ts">
import type { Dir, Sort } from '#shared/posts-view'

const props = defineProps<{
  label: string
  sortCol?: Exclude<Sort, 'default'>
  sort: Sort
  dir: Dir
  /** this column's filter differs from its default — the ⏷ stays visible and highlighted */
  active: boolean
}>()
const emit = defineEmits<{ sort: [] }>()
const slots = defineSlots<{ default?: () => unknown }>()

const sorted = computed(() => !!props.sortCol && props.sort === props.sortCol)
const ariaSort = computed(() => (sorted.value ? (props.dir === 'asc' ? 'ascending' : 'descending') : undefined))
</script>

<template>
  <!-- `group`: the ⏷ shows on hover or keyboard focus only, because the table has no spare width
       (1152px in 1152 at 1440) and the header labels are wider than the cells on four columns -->
  <div
    class="group inline-flex items-center gap-0.5 whitespace-nowrap"
    :aria-sort="ariaSort"
  >
    <button
      v-if="sortCol"
      type="button"
      class="inline-flex items-center gap-0.5 font-semibold hover:text-highlighted"
      @click="emit('sort')"
    >
      {{ label }}
      <UIcon
        v-if="sorted"
        :name="dir === 'asc' ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down'"
        class="size-3.5"
      />
    </button>
    <span
      v-else
      class="font-semibold"
    >{{ label }}</span>
    <UPopover v-if="slots.default">
      <UButton
        icon="i-lucide-list-filter"
        size="xs"
        :color="active ? 'primary' : 'neutral'"
        variant="ghost"
        :aria-label="`Filter by ${label}`"
        :class="active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'"
      />
      <template #content>
        <div class="p-3 min-w-48 space-y-3">
          <slot />
        </div>
      </template>
    </UPopover>
  </div>
</template>
```

- [ ] **Step 2: Replace the filter refs with URL-backed state** in `app/pages/index.vue`

Remove the refs `q`, `flags`, `type`, `scope`, `status`, `channel`, `minScore`, `posted`, `added` and `page`, the `offset` computed, and the `watch([q, flags, type, ...])` that resets selection and page. Add, near the top of the script after the imports:

```ts
import { activeChips, apiQuery, DEFAULT_VIEW, nextSort, OPTIONS, parseView, rangeKeys, viewQuery, type PostsView } from '#shared/posts-view'

const route = useRoute()
const router = useRouter()
const view = computed(() => parseView(route.query))

/** Every view change goes through here. Any change but the page itself returns to page 1. */
function setView(patch: Partial<PostsView>) {
  const next = { ...view.value, ...patch }
  if (!('page' in patch)) next.page = 1
  // Seekers carry the `seeking-work` flag, so asking for non-hiring posts under the default 'Unflagged'
  // would return only the unflagged non-jobs and hide the very rows this filter exists to show.
  if (patch.type === 'other') next.flags = 'all'
  router.replace({ query: viewQuery(next) })
}

// The search box types fast; the URL and the fetch follow 300ms behind.
const qInput = ref(view.value.q)
let qTimer: ReturnType<typeof setTimeout> | undefined
watch(qInput, (v) => {
  clearTimeout(qTimer)
  qTimer = setTimeout(() => setView({ q: v.trim() }), 300)
})
watch(() => view.value.q, (v) => { if (v !== qInput.value.trim()) qInput.value = v })

const page = computed({ get: () => view.value.page, set: p => setView({ page: p }) })
const offset = computed(() => (view.value.page - 1) * PAGE_SIZE)
const chips = computed(() => activeChips(view.value))
function clearChip(key: keyof PostsView) {
  setView(key === 'country' ? { country: [], countryMode: 'exclude' } : { [key]: DEFAULT_VIEW[key] })
}

const { data: countryOptions } = await useFetch<{ name: string, count: number }[]>('/api/posts/countries', { lazy: true, default: () => [] })
```

Change the `useFetch('/api/posts', ...)` call's `query` to:

```ts
  query: computed(() => apiQuery(view.value, PAGE_SIZE)),
```

Replace the old selection-reset watch with:

```ts
// Selection is TanStack state keyed by post key and outlives the rows on screen, so any view change —
// filter, sort or page — drops it; a bulk action must never point at posts nobody can see.
watch(() => route.fullPath, () => {
  rowSelection.value = {}
  anchorKey.value = null
})
```

Declare beside `rowSelection`: `const anchorKey = ref<string | null>(null) // the last row clicked, for shift-click ranges (Task 8)`.

Every remaining reference in the script and template to the removed refs (`status`, `type`, `flags`, …) reads `view.status`, `view.type`, … (in `<script>`: `view.value.status`). `grep -n "status ===\|minScore\|scope\b" app/pages/index.vue` after the edit and fix each hit.

- [ ] **Step 3: Replace the filter bar** — the block from `<UInput v-model="q"` through the last `<USelect ... minScore/posted/added>` becomes:

```vue
        <UInput
          v-model="qInput"
          class="max-w-sm"
          icon="i-lucide-search"
          placeholder="Search role, company, author, text..."
        />
        <UBadge
          v-for="c in chips"
          :key="c.key"
          color="neutral"
          variant="soft"
          class="gap-1"
        >
          {{ c.label }}
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="link"
            :aria-label="`Clear ${c.label}`"
            class="p-0"
            @click="clearChip(c.key)"
          />
        </UBadge>
        <UButton
          v-if="chips.length"
          label="Reset"
          size="xs"
          color="neutral"
          variant="ghost"
          @click="router.replace({ query: viewQuery({ ...DEFAULT_VIEW, q: view.q, sort: view.sort, dir: view.dir }) })"
        />
```

The bulk-action `<div class="ml-auto ...">` that follows stays (Task 8 replaces it).

- [ ] **Step 4: Headers** — in `columns`, add `const PostsHeaderCell = resolveComponent('PostsHeaderCell')` and `const URadioGroup = resolveComponent('URadioGroup')`, `const USelectMenu = resolveComponent('USelectMenu')`, `const USwitch = resolveComponent('USwitch')` beside the other `resolveComponent` calls, then a helper above `columns`:

```ts
/** A header cell: label, optional sort, optional one-field radio filter in the ⏷ popover. */
function header(label: string, sortCol?: 'score' | 'title' | 'posted' | 'added', field?: keyof typeof OPTIONS) {
  return () => h(PostsHeaderCell, {
    label,
    sortCol,
    sort: view.value.sort,
    dir: view.value.dir,
    active: !!field && view.value[field] !== DEFAULT_VIEW[field],
    onSort: () => sortCol && setView(nextSort(view.value, sortCol))
  }, field
    ? {
        default: () => h(URadioGroup, {
          'modelValue': view.value[field],
          'items': OPTIONS[field],
          'onUpdate:modelValue': (v: string | number) => setView({ [field]: v } as Partial<PostsView>)
        })
      }
    : undefined)
}
```

Set each column's `header`:

| Column `id` / `accessorKey` | `header:` |
|---|---|
| `score` | `header('Score', 'score', 'minScore')` |
| `title` | `header('Role', 'title', 'type')` |
| `emails` (Contact) | `header('Contact', undefined, 'channel')` |
| `flags` | `header('Flags', undefined, 'flags')` |
| `posted` | `header('Posted', 'posted', 'posted')` |
| `added` | `header('Added', 'added', 'added')` |
| `verdict` (Status) | `header('Status', undefined, 'status')` |
| `where` | the Where cell below |

The Where header needs scope **and** country:

```ts
  {
    id: 'where',
    header: () => h(PostsHeaderCell, {
      label: 'Where',
      sort: view.value.sort,
      dir: view.value.dir,
      active: view.value.scope !== 'all' || view.value.country.length > 0
    }, {
      default: () => [
        h(URadioGroup, {
          'modelValue': view.value.scope,
          'items': OPTIONS.scope,
          'onUpdate:modelValue': (v: PostsView['scope']) => setView({ scope: v })
        }),
        h(USelectMenu, {
          'modelValue': view.value.country,
          'items': (countryOptions.value ?? []).map(c => ({ label: `${c.name} (${c.count})`, value: c.name })),
          'valueKey': 'value',
          'multiple': true,
          'placeholder': 'Country',
          'class': 'w-56',
          'onUpdate:modelValue': (v: string[]) => setView({ country: v })
        }),
        h(USwitch, {
          'modelValue': view.value.countryMode === 'exclude',
          'label': 'Exclude these countries',
          'disabled': !view.value.country.length,
          'onUpdate:modelValue': (v: boolean) => setView({ countryMode: v ? 'exclude' : 'include' })
        })
      ]
    }),
    cell: /* unchanged */
  },
```

Keep each column's existing `cell`. Pass `sticky="header"` to `<UTable>` if Nuxt UI's `sticky` prop accepts `'header'` (check `node_modules/@nuxt/ui/dist/runtime/components/Table.vue` — it declares `sticky: [Boolean, String]`); otherwise `:sticky="true"`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npx eslint app/pages/index.vue app/components/PostsHeaderCell.vue && npm test`
Then `node scripts/screenshot.mjs "$TEMP/shots"` and read `posts.png`: headers show labels, sort arrow absent by default, the ⏷ shows on the Score header only after setting Score 6+ via `http://127.0.0.1:3939/?minScore=6` (add that URL to a one-off copy of the screenshot script, or check by hand). Confirm `/?sort=posted&dir=asc` shows the arrow up on Posted and ascending dates.

- [ ] **Step 6: Commit**

```bash
git add app/components/PostsHeaderCell.vue app/pages/index.vue
git commit -m "Posts grid: URL-backed view, sortable headers, filters in the column headers, chips and Reset"
```

---

### Task 8: Range selection and the bulk bar

**Files:**
- Create: `app/components/PostsBulkBar.vue`
- Modify: `app/pages/index.vue` (select column, bulk Draft, bulk Exclude dialog, draft poll)

**Interfaces:**
- Consumes: `rangeKeys` (Task 6); `POST /api/run/draft { keys }` (Task 4); `POST /api/settings/excludes { needles }` (Task 5).
- Produces: `PostsBulkBar` props `{ count: number, status: Status, busy: boolean }`, emits `draft | dismiss | restore | applied | unapplied | exclude | clear`.

- [ ] **Step 1: Create `app/components/PostsBulkBar.vue`**

```vue
<script setup lang="ts">
import type { Status } from '#shared/posts-view'

defineProps<{ count: number, status: Status, busy: boolean }>()
const emit = defineEmits<{ draft: [], dismiss: [], restore: [], applied: [], unapplied: [], exclude: [], clear: [] }>()
</script>

<template>
  <div class="flex items-center gap-1.5">
    <span class="text-sm text-muted">{{ count }} selected</span>
    <template v-if="status === 'dismissed'">
      <UButton label="Restore" icon="i-lucide-undo-2" size="xs" color="neutral" variant="outline" :disabled="busy" @click="emit('restore')" />
    </template>
    <template v-else-if="status === 'applied'">
      <UButton label="Un-mark" icon="i-lucide-undo-2" size="xs" color="neutral" variant="outline" :disabled="busy" @click="emit('unapplied')" />
    </template>
    <template v-else>
      <UButton label="Draft" icon="i-lucide-pen-line" size="xs" color="primary" :disabled="busy" @click="emit('draft')" />
      <UButton label="Applied" icon="i-lucide-check" size="xs" color="neutral" variant="outline" :disabled="busy" @click="emit('applied')" />
      <UButton label="Dismiss" icon="i-lucide-x" size="xs" color="neutral" variant="outline" :disabled="busy" @click="emit('dismiss')" />
      <UButton label="Exclude…" icon="i-lucide-ban" size="xs" color="neutral" variant="outline" :disabled="busy" @click="emit('exclude')" />
    </template>
    <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Clear selection" @click="emit('clear')" />
  </div>
</template>
```

Before replacing the existing bulk buttons in `index.vue`, read them (`<template v-if="selectedKeys.length">` … through its closing tag) and carry over any condition this component does not reproduce (e.g. which statuses show Applied). The component must offer exactly what the page offers today, plus Draft, Exclude… and Clear.

- [ ] **Step 2: Wire it in `index.vue`** — replace the `<template v-if="selectedKeys.length">…</template>` block with:

```vue
          <PostsBulkBar
            v-if="selectedKeys.length"
            :count="selectedKeys.length"
            :status="view.status"
            :busy="busy"
            @draft="draftSelected(selectedKeys)"
            @dismiss="setDismissed(selectedKeys, true)"
            @restore="setDismissed(selectedKeys, false)"
            @applied="setApplied(selectedKeys, true)"
            @unapplied="setApplied(selectedKeys, false)"
            @exclude="openBulkExclude"
            @clear="rowSelection = {}"
          />
```

- [ ] **Step 3: Bulk Draft and the poll fix** — beside `draft(key)`:

```ts
/** Bulk Draft: screened, like the batch run — the drafter may skip, and the skip is recorded. */
async function draftSelected(keys: string[]) {
  if (!keys.length || busy.value) return
  busy.value = true
  try {
    const r = await $fetch<{ queued: boolean, note?: string }>('/api/run/draft', { method: 'POST', body: { keys } })
    rowSelection.value = {}
    toast.add({
      title: r.queued ? `Drafting ${keys.length} post${keys.length > 1 ? 's' : ''}` : 'Already queued',
      description: r.queued ? 'Screened like the batch run: posts that fail a hard rule are skipped with a reason.' : r.note,
      icon: 'i-lucide-pen-line'
    })
    keys.forEach(k => drafting.add(k))
    draftTimer ??= setInterval(pollDraftLane, 3000)
  } catch (e) {
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}
```

In `pollDraftLane`, a queued bulk request carries `args.keys`, not `args.key` — change the `done` filter to:

```ts
  const done = [...drafting].filter(k => !running.includes(k)
    && !s.queue.some(q => q.args.key === k || (q.args.keys as string[] | undefined)?.includes(k)))
```

and extend the comment above `drafting` to say so.

- [ ] **Step 4: Range selection** — replace the `select` column's `cell`:

```ts
    // Shift-click selects from the last row clicked. The click handler runs before the checkbox's
    // update, so it records the modifier the update then reads.
    cell: ({ row }) => h('div', { onClickCapture: (e: MouseEvent) => { shiftHeld = e.shiftKey } }, [
      h(UCheckbox, {
        'modelValue': row.getIsSelected(),
        'onUpdate:modelValue': (v: boolean | 'indeterminate') => {
          const on = !!v
          const span = shiftHeld ? rangeKeys(data.value.rows.map(r => r.key), anchorKey.value, row.id) : [row.id]
          rowSelection.value = { ...rowSelection.value, ...Object.fromEntries(span.map(k => [k, on])) }
          anchorKey.value = row.id
          shiftHeld = false
        },
        'aria-label': 'Select row (shift-click for a range)'
      })
    ])
```

and declare beside `anchorKey` (from Task 7):

```ts
let shiftHeld = false
```

- [ ] **Step 5: Bulk Exclude** — generalise the dialog. Add:

```ts
const bulkNeedles = ref<{ value: string, on: boolean }[]>([])

/** Bulk Exclude: every distinct company and recruiter name on the selection, each ticked. */
function openBulkExclude() {
  const rows = data.value.rows.filter(r => rowSelection.value[r.key])
  const names = rows.flatMap(r => [r.company, r.author])
    .map(v => (v ?? '').trim())
    .filter(v => v.length >= 2 && v.toLowerCase() !== 'unknown')
  bulkNeedles.value = [...new Set(names)].map(value => ({ value, on: true }))
  excludeRow.value = null
  excludeOpen.value = true
}
```

Change `addExclude()` to take the list it saves:

```ts
async function addExclude(needles = [excludeNeedle.value.trim()]) {
  needles = needles.filter(n => n.length >= 2)
  if (!needles.length || busy.value) return
  ...
    await $fetch('/api/settings/excludes', { method: 'POST', body: { needles } })
  ...
      title: needles.length === 1 ? `Excluding "${needles[0]}"` : `Excluding ${needles.length} names`,
```

(both toast titles in the function change the same way). In the modal body, wrap the existing single-needle input and suggestions in `<template v-if="excludeRow">`, and add the bulk list:

```vue
          <template v-else>
            <UCheckbox
              v-for="n in bulkNeedles"
              :key="n.value"
              v-model="n.on"
              :label="n.value"
              class="py-0.5"
            />
            <p class="mt-3 text-xs text-muted">
              Each name matches anywhere in a post's text, as a whole word — a company name also hides posts that merely mention it.
            </p>
          </template>
```

The footer's Exclude button calls `excludeRow ? addExclude() : addExclude(bulkNeedles.filter(n => n.on).map(n => n.value))`, and its `:disabled` checks the list in bulk mode (`!bulkNeedles.some(n => n.on)`).

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npx eslint app/pages/index.vue app/components/PostsBulkBar.vue && npm test`
Then by hand in the browser at `http://127.0.0.1:3939/` (the Chrome extension cannot open localhost — use your own browser, or screenshot via `scripts/screenshot.mjs`): click row 2's checkbox, shift-click row 6 → 5 selected; the bulk bar shows Draft · Applied · Dismiss · Exclude… · ✕. Open Exclude… → the distinct companies and recruiters listed, ticked; **Cancel** (do not save — it writes real settings). Do **not** press bulk Draft in verification: it creates real Gmail drafts.

- [ ] **Step 7: Commit**

```bash
git add app/components/PostsBulkBar.vue app/pages/index.vue
git commit -m "Posts grid: shift-click ranges, bulk Draft (screened) and bulk Exclude"
```

---

### Task 9: Width, docs, and the HMR correction

**Files:**
- Modify: `app/pages/index.vue` (only if the width check fails), `CLAUDE.md`, `docs/superpowers/specs/2026-10-01-posts-grid-design.md`

- [ ] **Step 1: Measure the table width**

```bash
cat > scripts/.measure-tmp.mjs <<'EOF'
import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'chrome', headless: true })
for (const width of [1440, 1280]) {
  const p = await b.newPage({ viewport: { width, height: 950 } })
  for (const url of ['/', '/?status=all', '/?minScore=6&scope=remote&country=India']) {
    await p.goto('http://127.0.0.1:3939' + url, { waitUntil: 'networkidle' })
    await p.waitForSelector('table tbody tr td')
    const r = await p.evaluate(() => { const t = document.querySelector('table'); return { table: t.scrollWidth, container: t.parentElement.clientWidth } })
    console.log(width, url, r, r.table <= r.container ? 'fits' : 'OVERFLOWS')
  }
}
await b.close()
EOF
node scripts/.measure-tmp.mjs; rm scripts/.measure-tmp.mjs
```

Expected: `fits` on every 1440 line (active filters keep the ⏷ visible, which is the widest case). If one overflows, measure per column as on 2026-10-01 (widest content per `td`, header padding) and take the width from the column that is header-bound, not the Role cell, before changing anything. Record the 1440 and 1280 numbers in the Role cell's width comment.

- [ ] **Step 2: CLAUDE.md**

- In **The server and the UI**, replace the bullet beginning "**Nitro's dev HMR reloads server modules on every edit**" with:

  > **A server edit drops every running and queued job.** Nitro 2.13's dev server runs the app in a `worker_thread` and replaces it on every server rebuild (`nitropack/dist/core/index.mjs`: `new Worker`, then `terminate()` on the old one). `globalThis` is per thread, so `__jobfinderRunner` does **not** survive — measured 2026-10-01: one edit to `server/api/posts.get.ts` lost a running draft and 18 queued ones. It still survives module-level HMR inside one worker, which is all the `globalThis` placement buys. **Check `curl -s http://127.0.0.1:3939/api/job` before editing anything under `server/`.**

- In the paragraph beginning "**Pressing Draft on one post is the owner overruling the fit screen**", after the sentence about `const manual = !!args.keys?.length`, add:

  > **Bulk Draft is the exception:** the Posts view's bulk bar sends `{ keys }`, which `draft.post.ts` always enqueues with `screened: true`, and `manual = !!args.keys?.length && !args.screened`. A screened run is triaged like the batch run — skips are recorded — and `keyedDraftRows()` (`server/utils/draft-rows.ts`) gives it only posts with no `applications` row, because `persist()` would otherwise rewrite a `drafted` verdict as `skipped`. Pinned by `test/draft-rows.test.ts`.

- In **The pipeline, end to end**, item 4 (UI), add: "The Posts view is a grid: sort and filters live in the column headers, the whole view is in the URL (`shared/posts-view.ts`), and the country filter maps the model's free-text `location` through `countriesIn()` in `shared/countries.ts` — whose city table is filter-only and must never reach a prompt."

- [ ] **Step 3: Spec status** — change the spec's `Status:` line to `implemented on posts-grid` and the bulk-Draft body line to `{ keys: string[] (1..100) }` (the endpoint sets `screened` itself).

- [ ] **Step 4: Full verification**

Run: `npm test && npm run typecheck && npx eslint app server shared test/countries.test.ts test/posts-query.test.ts test/draft-rows.test.ts test/posts-view.test.ts && node --test test/identity.test.ts && node scripts/screenshot.mjs "$TEMP/shots"`
Expected: all pass, `no console errors`; read `posts.png` once more.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-01-posts-grid-design.md app/pages/index.vue
git commit -m "Docs: Posts grid, screened bulk Draft, and the Nitro worker restart that drops jobs"
```
