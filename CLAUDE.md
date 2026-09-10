# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

Mohamed Maher's personal job-search pipeline. It scrapes LinkedIn **posts** (not the Jobs tab) — content
search plus his own home feed — for roles that carry a contact email, scores each post against his CV, stores
everything in a local SQLite database, and drafts tailored application emails. Sending is always manual.

Target: senior frontend roles — Vue/Nuxt primary, React/Next secondary — remote anywhere, on-site or hybrid in
Egypt, Saudi Arabia, the UAE or Qatar. On-site outside those is out of scope. Personal recruiter addresses
(gmail etc.) are treated like company addresses: much real Egyptian and Gulf recruiting runs on them.

**This branch (`nuxt-rewrite`) is a rewrite.** `main` holds the original Node + Postgres + vanilla-JS version,
written for a different person. The design record is `~/.claude/plans/i-just-git-clone-snappy-axolotl.md`;
`docs/superpowers/` holds the *original* author's specs and describes the pre-rewrite system.

**Milestones: M1-M3 are built. M4 (Gmail) and M5 (cleanup) are not.** See "Not built yet" at the end.

## The pipeline, end to end

```
npm run dev ──► http://127.0.0.1:3939
                  │
   Run view ──────┼──► scraper/run.ts (Playwright + OpenAI)
                  │      emits NDJSON on stdout, progress on stderr
                  │           │
                  │           ▼
                  │    server ingests ──► data/jobfinder.db (Drizzle/SQLite)
                  │                              │
 Posts view ◄─────┴──────────────────────────────┤
                                                 │
 Pipeline view ◄── data/drafts/*.json ◄── claude -p (the drafter skill, zero tools)
```

1. **Scraper** `scraper/run.ts`: drives the installed Chrome (`playwright-core`, `channel: 'chrome'`, headed,
   its own profile in `./profile`) through LinkedIn content search, one term at a time (the literal term
   **`feed`** scrapes `linkedin.com/feed/` instead — same cards, no `datePosted` filter), scrolls until the
   card count stops growing, expands "… more", keeps posts whose text contains an email, sends survivors to
   OpenAI (`gpt-5-nano`, Responses API, strict JSON schema) with the CV text in the prompt.
   **It never writes the database.** Pure helpers live in `scraper/lib.ts` so the server and the tests share them.
2. **Ingest** `server/utils/ingest.ts`: the one place scraper output becomes rows. Used by the server (which
   spawns the scraper from the UI) and by `scraper/ingest.ts` (the CLI pipe), so both behave identically.
3. **Drafter** `.claude/skills/job-application-drafter/SKILL.md` + `server/utils/drafter.ts`: the server picks
   the posts, groups them by recruiter, and runs one `claude -p` session per recruiter with **no tools at
   all**. The skill returns JSON only. The server validates it, writes the email, and records the verdicts.
4. **UI** `app/`: Nuxt UI v4 dashboard — Posts, Pipeline, Run, Settings.

## Commands

```bash
npm run dev                                  # http://127.0.0.1:3939 (port pinned, see gotchas)
npm test                                     # 46 tests: helpers, ingest, drafter contract, invariants
npm run lint / npm run typecheck
npm run login                                # one-time LinkedIn login into ./profile (redo when runs exit 2)
npm run dry -- --terms "vue nuxt developer" --max 10   # prints cards, stores nothing, no OpenAI call
node scraper/run.ts | node scraper/ingest.ts # CLI scrape; normally you press Start scrape in the Run view
npm run db:generate && npm run db:migrate    # after editing server/db/schema.ts
node scripts/screenshot.mjs [outDir]         # screenshots every view (see the localhost gotcha)
sqlite3 data/jobfinder.db                    # macOS ships sqlite3 at /usr/bin/sqlite3
```

`--rescore` and `--reflag` are carried over. Both *update* existing rows, which the read-only scraper cannot
do, so they use the same NDJSON channel: the scraper emits `{op:'update'|'reflag', ...}` and the server applies
it. Trigger them from the Run view's Maintenance row.

## Data model (SQLite, `data/jobfinder.db`, Drizzle)

Schema in `server/db/schema.ts`; migrations in `server/db/migrations/`, applied at boot by
`server/plugins/migrate.ts`. Translated off the original Postgres schema:

| Postgres | SQLite |
|---|---|
| `emails text[]`, `flags text[]` | JSON columns, read with `json_each` / `json_array_length` |
| `cardinality(flags) = 0` | `json_array_length(flags) = 0` |
| `$email = ANY(p.emails)` | `EXISTS (SELECT 1 FROM json_each(posts.emails) WHERE value = ?)` |
| `timestamptz` | `integer({ mode: 'timestamp' })` — epoch **seconds** |
| lower-case email constraint | `CHECK (email = lower(email))` |

- **`posts`** — one row per scraped post. `key` = sha1(author_url + first 160 chars of text with drifting
  header markers stripped). `score` 0-10 and `reason` are model output against the CV: **ordering hints only,
  and `reason` overclaims** — never copy it into an email. `emails` comes from a deterministic regex, never
  from the model. `in_scope` (was `mena`) means Egypt/Saudi/UAE/Qatar or genuinely location-free remote.
- **`posts.flags`** — pre-screen hints mirroring the skill's hard skips, produced by `prescreen()` in
  `scraper/lib.ts`: four regex rules in `FLAG_RULES` (`residency-gate`, `night-shift`, `junior`,
  `wordpress-only`) plus `junior-years`, which comes from a separate years-of-experience check and is not in
  that table. Hints only; the drafter confirms them in the text, and the UI and the drafter queue sort flagged
  posts last. **`immediate-start` was deliberately removed** — Mohamed can start immediately, so flagging it
  would demote good posts for what is now an advantage.
- **`applications`** — one row per post touched. `verdict` drafted|skipped. Reasons for drafted posts **must**
  start with `named in application` / `named in follow-up`; the follow-up query relies on that prefix.
- **`contacts`** — one row per recruiter email. `stage` drafted → contacted → followed_up → final, or replied.
  **Two emails per address, ever.** `final` is never reset — enforced by `WHERE contacts.stage <> 'final'` on
  the upsert, not by prose.

## Configuration

**`config.json` is the single source for the profile, constraints and search settings, and the Settings page
is a form over it.** Nothing here is hardcoded in the source — `test/invariants.test.ts` fails if a contact
detail appears under `server/`. Both the scoring prompt (`systemPrompt` in `scraper/lib.ts`) and the drafter's
system prompt (`profileBlock` in `server/utils/drafter.ts`) are built from it at run time, so editing Settings
changes the next scrape and the next draft.

- `profile` — name, title, location, email, phone, LinkedIn, GitHub, languages, years.
- `constraints` — `remoteAnywhere`, `onsiteCountries`, `willRelocate`, `canStartImmediately`, `workingHours`,
  `stackWeighting` (`vue-primary` | `equal` | `react-primary`).
- `cv` — path to the CV PDF. The scoring model reads the PDF itself once per run (`input_file`); no PDF library.
- `terms` (the home feed plus 8 searches), `titles` (30, for the scoring prompt), `max`, `since`.
- Validated server-side by `server/utils/config.ts`; a bad CV path or an empty terms list is refused with a
  readable message and `config.json` is left untouched.
- **`.env`** — `OPENAI_API_KEY`; optionally `JOBFINDER_DB`, `JOBFINDER_MODEL`, `PROFILE_DIR`. Loaded with
  Node's `--env-file-if-exists`. Never write the key into a tracked file.

The skill file holds Mohamed's evidence, gaps and screening rules as a snapshot from
`/Volumes/Data/projects/CV/app/mohamed-maher-cv/app/data/resume.ts`. **If the CV changes, update the skill's
Evidence and Gaps sections**, or drafts keep hedging on stale gaps.

## Gotchas (each cost real time)

### LinkedIn and the scraper

- **Do not add `contentType=["jobs"]` to the search URL.** It means "posts embedding a Job card" and returns
  almost nothing with no emails. Only `datePosted` is used.
- **LinkedIn's DOM has hashed class names and no post URN.** Cards are found structurally (the container whose
  children each hold an author link) and read via `innerText`. Results live inside a scrolling `<main>`;
  scroll with `page.mouse.wheel`, not `window.scrollTo`. Emails render as `mailto:` links.
- **Locale is pinned to en-US but it does not hold**: LinkedIn renders the first ~10 cards in the *account's*
  language (Arabic) and scroll-loaded ones in English. `normalize()` folds the Arabic age back into English
  (`٣ من الساعات` → `3h`) before the age regex or the dedupe key see it. The two render paths can still key the
  same post twice; rare, and the email is identical either way, so no recruiter is contacted twice.
- **The feed's reposts name the wrong author** unless you look: a card opening with "X reposted this" links X
  first. `readCards` picks the **most repeated** href — the real author is linked three times (avatar, name,
  menu), a resharer twice.
- **The drifting-header dedupe bug:** the first key included "21h", so the same post came back as "22h".
  Anything added to the key must be stable across runs. Covered by tests.
- **Rate-limit posture:** 9 terms, 40 cards, randomized pauses, headed Chrome, `--enable-automation` off. A
  LinkedIn checkpoint page is treated as a lost login (**exit 2**, `login expired`). Fix with `npm run login`.
  Avoid many manual scrapes in one day.
- **Scoring failures are not stored**: the post is retried next run rather than sitting with a NULL score.

### The headless drafter (`claude -p`)

- **`--allowed-tools` and `--disallowed-tools` are variadic.** A flag that follows one with no values of its
  own is swallowed as a tool name — this silently dropped `--append-system-prompt` *and* left Bash enabled.
  `--allowed-tools` also refuses an empty list, so the allow list names a tool that does not exist
  (`NoToolsPermitted`) and the deny list is explicit.
- **`claude -p` loads the CLAUDE.md of its working directory.** Running the drafter in the project root leaked
  the previous owner's name into a report. It now spawns from an empty temp directory (`neutralCwd()`): it has
  no tools, so it needs nothing from this folder, and the injected identity is the only one it can see.
- **`--strict-mcp-config` with an empty MCP config cuts startup from 3-5 minutes to ~30s** on this machine,
  which has ~10 MCP servers. It also removes all tool risk, so the old allow-list-inheritance problem is gone.
- **The skill must never see a tool.** `test/invariants.test.ts` asserts the deny list and the neutral cwd.
- **A skip must never downgrade a `drafted` verdict.** Re-drafting a recruiter with a pending draft once
  rewrote the verdict to `skipped`, destroying the `named in ...` prefix the follow-up query needs — the
  recruiter would later have been told about a role the first email already covered. The skip insert carries
  `WHERE applications.verdict <> 'drafted'`.

### The server and the UI

- **Nitro's dev HMR reloads server modules on every edit**, which would forget a running job: the scraper kept
  writing rows while the UI showed an idle lane and Stop had nothing to kill. Job lane state lives on
  `globalThis` (`__jobfinderRunner`) so it outlives module reloads. **Any long-lived server state needs the
  same treatment.**
- **Port 3939 is pinned** in `nuxt.config.ts`. Port 3000 is taken on this machine, and Nuxt silently drifting
  to 3001 would invalidate the Gmail OAuth redirect URI.
- **The server is the sole writer of the database.** The scraper opens it read-only and streams rows back.
  Keep it that way: two writers is how you get `SQLITE_BUSY` under a long scrape.
- **`UDashboardPanel`'s `#body` is a flex column** — cards need `class="shrink-0"` or they get clipped
  instead of scrolling.
- **The Claude-in-Chrome extension cannot open localhost.** Verify the UI with `node scripts/screenshot.mjs`,
  which drives headless Chrome through `playwright-core`.
- **Two job lanes and a queue** in `server/utils/jobs.ts`: the scrape lane (one at a time, Chrome profile lock)
  and the draft lane run concurrently; everything else queues, so `POST /api/run/*` returns 202 and never 409.
  Single-post draft requests waiting in the queue are batched into one `claude` session. Stop sends SIGTERM;
  Playwright's own handler only closes Chrome, so the scraper keeps a `stopping` flag and throws at the next
  loop check (exit 1).

### Environment

- **PostgreSQL is not installed and Docker owns port 5432** (`onebench-postgres`, another project). That is
  why this branch moved to SQLite rather than following the original `SETUP.md`.
- **npm, not pnpm.** The Nuxt UI dashboard template ships `packageManager: pnpm@12.3.4`, `pnpm-lock.yaml` and
  `pnpm-workspace.yaml`; all three were removed. A standalone pnpm 10 exists on this machine, but the pinned
  v12 is what breaks corepack.
- **`@unovis` was dropped** from the template: it pulls `maplibre-gl` with a critical XSS advisory whose fix
  needs a major bump `@unovis` cannot take, and nothing here renders a map or a chart.
- **The CV PDF is ~1.4 MB** (the original was built around 75 KB). Fine for the OpenAI file read and for
  Gmail, but every application carries it.

## Conventions

Single-purpose files, no build step beyond Nuxt's. Dependencies limited to what the template ships plus
`playwright-core`, `openai`, `better-sqlite3` and `drizzle-orm`. The scraper is TypeScript run directly by
Node 22's native type stripping — no compile step, and `scraper/lib.ts` is importable by the server and the
tests. Deliberate ceilings are marked with `ponytail:` comments. Every non-trivial change ships with one
runnable check (`npm test`, a curl, or a dry run). Prefer a test over a comment for anything that would be
silently expensive if reintroduced — that is what `test/invariants.test.ts` is for.

## Not built yet

- **M4 — Gmail.** OAuth loopback flow, `gmail.drafts.create` with the CV attached, the 8-row stage machine,
  follow-up countdowns, `scheduledTasks` cron, `.db` backups. Until then the Pipeline view reads drafts from
  `data/drafts/*.json` and nothing is ever sent.
  - **When you build the callback, port the `state` nonce** from upstream commit `e8be7b6`. Google's redirect
    into the callback is itself a cross-site GET, so an Origin / Sec-Fetch-Site guard must exempt GETs and
    cannot protect it; without a one-shot random `state`, any page open in the browser could feed the server
    its own `code` and have the drafts written into its mailbox. Verify with a forged callback: 400, and
    `gmail-token.json` untouched.
  - Scopes: `gmail.compose` **and** `gmail.readonly` (the metadata scope rejects the `q=` search the sweep
    needs). `gmail.compose` includes permission to *send*, so never-sending is a property of this code —
    `test/invariants.test.ts` fails if a send call appears under `server/`.
- **M5 — cleanup.** Delete `jobfinder.js`, `ui.js`, `ui.html`, `scrape.js`, `schema.sql`,
  `com.jobfinder.plist` and their `eslint.config.mjs` ignore entries. They are kept only as porting references
  for M4's Gmail OAuth and MIME building. **`SETUP.md` still describes the Postgres version and is wrong.**

## Never commit

`profile/` (a live LinkedIn session), `.env`, `data/` (the database and drafts), `google-oauth.json`,
`gmail-token.json`, `backups/`, `logs/`, `jobs.csv`. `.gitignore` covers all of them — verify with
`git check-ignore <path>` rather than by eye, and note that a trailing-slash pattern only matches a directory
that already exists.

**The git remote is `git@github.com:shaltut/job-finder.git` — the original author's repository, not
Mohamed's.** `config.json` now carries his phone and email. Do not push without confirming the remote.
