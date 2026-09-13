# The exclude list — never show posts mentioning X

**Status:** implemented, 2026-09-14.

## Context

Testing the live pipeline surfaced a post scoring **9/10** — a real vacancy, a real contact route, a
genuine match against the CV — from a freelance recruiter whose posts all funnel into one AI-interview
platform the owner does not want to work through. Two such rows were stored, both already dismissed by
hand. Dismissal is per-post, so the same source returns with every scrape, scoring just as well each
time, and the owner triages it again.

The tool already had an exclusion concept: `scope.excludedRoles`. But it is prose spliced into the
scoring prompt (`fieldRule` in `scraper/lib.ts`: those roles "score 0-2 even when the title words
match") and into the drafter's system prompt. It is soft, and the repo already records what soft
gets you — the scoring model "classifies reliably but does not reliably act on its own
classification", which is why `gateOnPostType()` zeroes the score in code rather than asking for it.
This is the deterministic counterpart, for the axis the model was never asked about: **who is
posting**, as opposed to what the role is.

## What the stored corpus showed

Measured against the live 42-row `data/jobfinder.db` before any code was written.

| Finding | Consequence |
|---|---|
| `company` is `unknown` for **14 of 42** posts — including both target rows — and inconsistent when set (`MilesAssist` beside `Miles Assist`) | Do not match the `company` column, and do not offer a list labelled "companies". It would promise matching a field that is blank a third of the time and misspelt in the rest. |
| The scraped `text` opens with the LinkedIn card header — author name, headline, age | One text match covers all three things the owner might mean. `waleed kolty` matched all 3 of that recruiter's posts; `micro1.ai` matched only the 2 that mention it. |
| `ai` as a bare substring matched **36/42**; with word boundaries, **9/42**. `intern` matched 12 vs 7 (`Internix.io`, "international") | Word-boundary matching is load-bearing, not a nicety. |
| `micro1.ai` matched exactly **2/42** either way | A domain-shaped needle is already precise; the boundary costs it nothing. |
| The href is an opaque `lnkd.in` hash; `jobs.micro1.ai` was only ever visible because the post wrote it out | Excludes match prose, never link targets. A real limit, documented rather than papered over. |

## Decisions

### The effect is a flag, not a drop

`excluded` is an ordinary entry in `posts.flags`. Almost everything then comes for free: a non-empty
`flags` already drops a post from the drafter queue (`jobs.ts`), already hides it from the Posts view,
and is already recomputable over stored rows by `--reflag` — a read-only text pass with no browser and
no API calls.

Two alternatives were rejected:

- **Dropping the card at admission**, beside the `admits()` channel gate. The OpenAI saving is
  negligible on `gpt-5-nano`, a dropped post leaves no evidence a rule fired, and the rows already
  stored would never be caught. For a blunt text match the owner is still tuning, invisibility is the
  wrong property.
- **Writing `dismissed_at`.** A rule-dismissal would be indistinguishable from the owner's own triage,
  so deleting a rule could not restore the posts. Reversibility is the whole argument for a flag.

### One list, matched against the post text

`excludes: string[]`, labelled "Never show posts mentioning". Not a companies list and a terms list:
both would match the same text with the same rule, so the split would be cosmetic, and the
"companies" half would be a promise the data cannot keep.

It is read by the pre-screen only. It never reaches a prompt — a hard rule the owner wrote does not
need the model's opinion of it.

### Matching is an escaped literal with a conditional word boundary

A boundary is added **only where the needle's own edge is an ASCII word character**, because `\b` is
ASCII-only in a JS regex — the same trap `extractPhones` documents for its Arabic cues. `micro1.ai`
compiles to `/\bmicro1\.ai\b/i`, `C#` to `/\bC#/i`, and an Arabic needle to no boundary at all. Every
needle is escaped, so a stray `+`, `|` or `(` cannot silently widen a rule.

### Every rule fails open

An empty list yields `null`, never `/(?:)/`, which matches every post. This is the contract
`flagRules()` already states: a flag removes a post from the drafter queue outright, so a false
positive costs a lead while a false negative only costs a sort position. A schema `min(2)` blocks the
single-character needle — `.` alone matched 42/42.

### No database migration

`flags` and `settings.json` are existing JSON columns, and `upgradeSettings`/`shapeOver` rebuilds every
stored row into the current shape on each read, filling a new key from `EMPTY_SETTINGS`. A row written
before the key existed upgrades to `excludes: []` — the only safe fill, since any non-empty default
would start hiding posts nobody asked it to hide.

### Backfill is automatic, and it waits

`POST /api/run/reflag` returns 202 and only *queues*; `reflag` runs on the **scrape lane**, so it can
sit behind a running scrape. `useReflag` polls `/api/job` at the Run view's own 1500ms cadence until
the job is neither current nor queued, then reports the count. Refreshing on the 202 would show stale
rows and read as a no-op.

The count comes off the job's `done` record rather than from a `flags=excluded` query, because that
query respects the deliberately unconditional `dismissed_at IS NULL` clause in `posts.get.ts` and would
undercount a post that was both dismissed and excluded — which is exactly the state of the two rows
that motivated the feature.

## Sequence

1. `shared/settings.ts` — `excludes` in `settingsSchema` and `EMPTY_SETTINGS` at the same key position
   (key order is load-bearing for the Settings dirty check), plus case-folded dedupe in `parseSettings`.
2. `scraper/lib.ts` — `excludeRule()`, wired into `flagRules()` as `excluded`.
3. `scraper/run.ts` — `--reflag` counts the excluded subset onto its `done` record; the dry run marks a
   card the rule would catch, so a needle can be measured before it is saved.
4. `server/` — `flags=excluded` on the posts endpoint; `POST /api/settings/excludes`; the count plumbed
   through `jobs.ts`.
5. `app/` — the Settings list, `useReflag`, the Posts filter option, and **Exclude…** in a row's ⋯ menu.
6. Tests, including one that pins the drafter queue's `json_array_length(p.flags) = 0`.

## Verified

- `npm test` — 193 pass. The new invariant was mutation-checked: removing the predicate from `jobs.ts`
  fails it.
- The real `--reflag` against a copy of the live database emitted `{"op":"done","added":0,"excluded":2}`
  and logged `reflagged 42 posts, 20 carry at least one flag, 2 excluded`.
- Through the running app: the endpoint refuses a one-character needle with 400, dedupes `MICRO1.AI`
  onto `micro1.ai`, and the job reports `excluded: 2`. `flags=excluded` returns 0 under the default
  status and 2 under Status: Dismissed, as the dismissed clause dictates.
- Full UI round trip: ⋯ → Exclude…, prefilled with the author and offering `t.mercor.com` scraped from
  the post prose; the toast reported "3 posts now excluded"; removing the rule and re-flagging brought
  the third post back.
- The failure path, by making `/api/job` return 500: the save toasts "Settings saved" and then
  "Saved, but the re-check did not run", never "Not saved". The re-flag runs outside the save's
  try/finally for exactly this reason, and because it shares the scrape lane — holding the Save button
  disabled for the length of a running scrape would show "saving" while nothing is being saved.

**Not exercised**, and worth doing on the next real scrape:

- The slow path itself — queueing a re-flag while a scrape holds the lane, and confirming the
  "Re-check queued" toast fires rather than the UI looking hung. The logic is unit-reasoned from
  `runJob` assigning `lanes[lane].current` synchronously, not observed.
- The dry run's `EXCLUDED` marker, which needs a live LinkedIn fetch. Avoided on purpose: manual
  scrapes are rate-limited and this change did not otherwise need one.

## Known limits

- **A rule matches prose, not a link's destination.** A post linking to an excluded company without
  naming it is not caught.
- **A short needle is still the owner's own foot.** `ai` matches 9 of 42 posts even with boundaries.
  `min(2)` blocks only the pathological case; **Flags: Excluded** and `npm run dry` are the audit.
- **The single-key draft path carries no flags predicate** (`jobs.ts`), so pressing Draft on an excluded
  post still drafts it. Pre-existing for every flag, and it reads as a deliberate owner override.
- **Two open tabs can clobber an exclude** — Settings in one, a row action in the other. Same class as
  the CV-upload bug.
- **The per-row verdicts moved into a ⋯ menu** — Mark applied, Dismiss, Exclude… — so each is two
  clicks rather than one, leaving Draft as the only button. A sixth button in that column truncated the
  Status cell to "unproce", and this column is already the first thing to go off-screen on a laptop.
  The menu is ordered by how far each verdict reaches: this post, this post for good, this source
  forever. A dismissed row offers Restore beside a menu holding only Exclude…

## Out of scope

- Excluding by `company` or `author_url` as structured columns. Measured as unreliable above, and the
  text match already covers both in practice.
- Following `lnkd.in` redirects to recover a real domain. That is an extra authenticated request per
  link against the account the scraper already rate-limits.
- Any change to the `dismissed_at IS NULL` clause in `posts.get.ts`. The existing Status filter already
  expresses the distinction, and that clause was made unconditional on purpose.
