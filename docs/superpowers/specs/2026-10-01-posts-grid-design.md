# Posts view as a grid: column sort, header filters, bulk triage

Date: 2026-10-01 · Branch: `posts-grid` · Status: approved design, not yet implemented

## Why

The owner triages by **scanning the list and acting in bulk**, rarely opening a post. Three things slow
that down today:

1. **No sort.** `/api/posts` has one fixed order (flagged last, score, posted date) and no header is
   clickable.
2. **The filter bar is a wall.** A search box and eight dropdowns in a wrapping row, none showing
   whether it differs from its default, and no reset.
3. **Bulk actions stop short.** The bulk bar can Dismiss and mark Applied, but Draft is one row at a
   time, Exclude is one row at a time (⋯ → Exclude…), selecting is one checkbox at a time, and there
   is no way to narrow by country.

Out of scope, by the owner's choice: the KPI strip and the paste card stay where they are; a filter
by country is a **view filter only** — nothing is saved and the drafter queue is unaffected.

## Decisions

| Question | Decision |
|---|---|
| Overall approach | Rework the existing `UTable` in place; sorting, filtering and paging stay server-side (1,600 posts × up to 6,000 chars of text rules out loading everything). |
| Filter layout | **Filters live in the column headers**, grid-style. Search stays above the table. |
| Bulk Draft semantics | **Screened**, like the batch run — not hand-picked like the row's Draft button. |
| Country | A view filter over the model-extracted `location`, include or exclude. |

## 1. Sorting and URL state

**API.** `/api/posts` gains two allowlisted params:

- `sort`: `default | score | title | posted | added`
- `dir`: `asc | desc`

`default` reproduces today's order exactly. Every explicit sort keeps **flagged-last as its first key**:
flagged posts are excluded from the drafter queue, and floating them to the top would mix rows that
can never be drafted into a triage pass. Under **Flags: Flagged only** every row is flagged, so the
first key is inert and the sort behaves normally. NULLs sort last in both directions (pasted posts have
no `posted_at`). A final tiebreak on `key` keeps paging stable.

| `sort` | Column |
|---|---|
| `score` | `posts.score` |
| `title` | `lower(posts.title)` |
| `posted` | `posts.posted_at` |
| `added` | `posts.scraped_at` |

**Headers.** Score, Role, Posted and Added are sortable: clicking the label cycles
desc → asc → default. The active column shows an arrow and sets `aria-sort`.

**URL.** Every filter, the sort and the page number live in the query string
(`?status=unprocessed&sort=posted&dir=desc&page=2`), so refresh, back and bookmarks keep the view. A
missing param means today's default, so a bare `/` is unchanged. A sort change clears the selection and
returns to page 1, as a filter change already does.

## 2. Filters in the column headers

Each filterable header carries a small ⏷ button that opens that column's filter in a popover. Clicking
the label sorts; clicking ⏷ filters — two separate targets.

| Column | Filter |
|---|---|
| Score | Any / 6+ / 8+ |
| Role | Post type: Hiring only / Any / Not hiring |
| Contact | Any / Email / Link / Phone |
| Where | Anywhere / In scope / Remote, **plus Country** (multi-select, include or exclude) |
| Flags | Unflagged / Any / Flagged only / Excluded |
| Posted | Any time / 24h / 3 days / week / month |
| Added | Any time / 24h / 3 days / week / month |
| Status | Unprocessed / All active / Drafted / Skipped / Applied / Dismissed |

- **Search stays above the table**: it covers role, company, author and the whole text, not one column.
- **A chip row** beside the search lists only the filters that differ from their defaults, each
  removable, plus **Reset**. A closed popover hides state, and a highlighted icon is easy to miss.
- The existing coupling stays: choosing **Not hiring** sets Flags to Any, because seekers carry the
  `seeking-work` flag (see the `watch(type)` comment in `index.vue`).
- **The header stays visible** while the table scrolls.
- **Width.** The table measured 1152px in a 1152px container at 1440 after the Posted/Added split —
  zero slack — and on Score, Flags, Posted and Added the header label is wider than the cells. So the
  ⏷ is shown only on header hover, on keyboard focus within the header (`focus-visible`, so it stays
  reachable without a mouse), and permanently while that column's filter is active; buttons are
  `xs` icon-only with an `aria-label` naming the column. **Verify by measurement**
  (`table.scrollWidth <= container.clientWidth`) at 1440 and 1280, not by eye.

## 3. Selection and bulk actions

**Selection.** Shift-click a checkbox to select the range from the last one clicked. The header
checkbox selects the current page (up to 100). **No select-all-across-pages**: a bulk Draft over
hundreds of posts is too easy to trigger by accident.

**Bulk bar:** Draft · Dismiss · Applied · Exclude… · Clear. (Restore / Un-mark replace Dismiss /
Applied in the Dismissed and Applied views, as today.)

### Bulk Draft — screened

`POST /api/run/draft` accepts `{ keys: string[] (1..100, sha1 each), screened: true }` beside the
existing `{ key }` and `{ n }`.

- `JobArgs` gains `screened?: boolean`. In `runDraftJob`:
  `const manual = !!args.keys?.length && !args.screened`. Screened means the drafter may skip, and the
  skip is recorded with its reason, exactly as in the batch run.
- **Screened rows are only posts with no `applications` row** — the batch query's `a.key IS NULL`,
  added to the keyed query when `screened`. This is not a nicety: `persist()` does not guard against
  rewriting a `drafted` verdict as `skipped` (CLAUDE.md, "A skip must never downgrade a drafted
  verdict"); the batch queue never reaches it *because* of `a.key IS NULL`, and a screened keyed path
  without that clause would. Selected posts that already have a verdict are left alone and the job
  log says how many and why.
- A screened item is a `keys` item, which `pump()` never coalesces with single-`key` requests, so the
  two modes cannot mix inside one session. `enqueue()` drops keys already queued or running.
- A post the screened run skips keeps its row Draft button (it gates on `verdict === 'drafted'`), so
  the owner can still overrule it one at a time.
- All the existing gates apply unchanged: the Gmail gate, the two-emails ceiling, one application
  per recruiter.

### Bulk Exclude

The dialog lists the distinct `company` and `author` values of the selected rows (blank and `unknown`
dropped), each ticked; the owner unticks what they do not want and confirms. `POST
/api/settings/excludes` accepts `needles: string[]` beside `needle`, appends all of them, and enqueues
**one** reflag. The dialog says that a name matches anywhere in a post's text — the exclude rule's
semantics, unchanged.

### Dismiss / Applied

Unchanged endpoints; faster only through range selection.

## 4. Country filter

`location` is free text from the scoring model. Measured over the 1,613 live posts on 2026-10-01:

| | posts |
|---|---|
| empty, `unknown` or `Remote` | 246 |
| resolved by `homeCountryOf()` (comma segments) | 680 |
| + any country name/alias as a whole word, + US `City, ST` → USA | 369 |
| still unresolved — mostly bare city names | 318 |
| **with the filter-only city table (`countriesIn`, measured after Task 1)** | **1,256 of 1,367 located = 92%** (was 77%) |

- New `countriesIn(location): string[]` in `shared/countries.ts`: `homeCountryOf`, then a whole-word
  scan for every country name and alias, then a US-state suffix → USA. A location can name several
  countries ("Remote (Bulgaria / Romania / Poland)"); 8 posts did.
- **A small city table** for the measured top misses (Bangalore, Bengaluru, Hyderabad, Pune, Chennai,
  Mumbai, Noida, Gurugram, Indore, Dubai, Abu Dhabi, Riyadh, Jeddah, Cairo, Lahore, …), used **only by
  this filter**. It must never feed `withAliases()`, or city names would enter the scoring prompt.
  Re-measure coverage after adding it and record the number here.
- Server: select distinct `location` values (~440), map them in JS, then filter with
  `location IN (…)` (include) or `NOT IN (…)` (exclude). No schema change, no rescore.
- The picker offers **No country** (empty, unknown, remote and unresolved), so what the mapping misses
  stays visible rather than passing an exclude silently.
- Params: `country` (repeatable country names) and `countryMode` (`include | exclude`).

## 5. Structure

- `app/components/PostsHeaderCell.vue` — label + sort button + ⏷ filter popover for one column.
- `app/components/PostsBulkBar.vue` — the selection actions and the Exclude dialog trigger.
- `app/pages/index.vue` keeps the state and the URL sync; it is ~1,000 lines today and should shrink.

## 6. Testing

- `countriesIn` over real location shapes: comma form, word inside prose, US state, bare city,
  multi-country, unresolved.
- Sort allowlist, and flagged-last as the first key under every sort.
- Screened bulk Draft leaves posts with an existing verdict untouched — and the control: the row
  Draft button (single `key`) is still hand-picked. Extend `test/manual-draft.test.ts`.
- Excludes endpoint with a list enqueues exactly one reflag.
- Width measured at 1440 and 1280.

## 7. Operating constraint

**No edit under `server/` while a job is running or queued.** Nitro 2.13's dev server runs the app in
a `worker_thread` and replaces it on every server rebuild; `globalThis.__jobfinderRunner` is
per-thread and does not survive. Measured 2026-10-01: one edit to `server/api/posts.get.ts` dropped a
running draft and 18 queued ones. Check `curl -s http://127.0.0.1:3939/api/job` before each server
edit. (CLAUDE.md still says lane state survives HMR — that claim needs correcting.)
