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
written for a different person. The design record, including what changed during implementation and the
known gaps, is `docs/superpowers/specs/2026-09-10-nuxt-rewrite-design.md`; the two `2026-09-06-*` specs
beside it describe the pre-rewrite system.

**The rewrite is complete (M1-M5).** Gmail works but needs `google-oauth.json` — see Gmail below. Until it
is connected, drafts fall back to `data/drafts/*.json` and everything else works unchanged.

The pre-rewrite implementation (`jobfinder.js`, `ui.js`, `ui.html`, `scrape.js`, `schema.sql`,
`com.jobfinder.plist`) is **deleted here but preserved in git** — read one with `git show main:ui.js`. Source
comments that mention those files are historical attribution, not live references.

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
 Pipeline view ◄── Gmail drafts (CV attached) ◄── claude -p (the drafter skill, zero tools)
                   └─ data/drafts/*.json when Gmail is not connected

 Settings view ──► settings row in the same .db ──► read by the scraper (read-only) and the drafter
                   └─ CV PDF uploaded to data/cv/, and "Prefill from CV" fills the blanks
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
npm test                                     # 99 tests: helpers, settings, ingest, drafter, stages, MIME, invariants
npm run lint / npm run typecheck
npm run login                                # one-time LinkedIn login into ./profile (redo when runs exit 2)
npm run dry -- --terms "vue nuxt developer" --max 10   # prints cards, stores nothing, no OpenAI call
node scraper/run.ts | node scraper/ingest.ts # CLI scrape; normally you press Start scrape in the Run view
npm run db:generate && npm run db:migrate    # after editing server/db/schema.ts
node scripts/screenshot.mjs [outDir]         # screenshots every view (see the localhost gotcha)
sqlite3 data/jobfinder.db                    # macOS ships sqlite3 at /usr/bin/sqlite3
sqlite3 data/jobfinder.db 'select json from settings'   # the settings that replaced config.json
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
  header markers stripped). `post_url` is the permalink, null when the run could not resolve one — see the
  URN gotcha below. `score` 0-10 and `reason` are model output against the CV: **ordering hints only,
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
- **`settings`** — exactly one row (`id = 1`), holding the whole config as JSON. One column rather than
  normalised tables because nothing queries an individual setting: every consumer wants the whole object.
  Plain `text`, not Drizzle's `mode: 'json'` — the scraper and the server read it through a raw
  better-sqlite3 handle so the parse is explicit at both ends and cannot double-encode. A `CHECK (id = 1)`
  makes the single row a property of the database rather than of prose.
- **`contacts`** — one row per recruiter email. `stage` drafted → contacted → followed_up → final, or replied.
  **Two emails per address, ever.** `final` is never reset — enforced by `WHERE contacts.stage <> 'final'` on
  the upsert, not by prose.

## Configuration

**Settings live in the database — one row in the `settings` table — and the Settings page is a form over
it.** `config.json` is gone: it was git-tracked, so a real phone number and email address sat in a repository
whose remote belongs to someone else. Nothing here is hardcoded in the source either —
`test/invariants.test.ts` fails if a contact detail appears under `server/`, and a second invariant fails if
any file starts reading `config.json` again. Both the scoring prompt (`systemPrompt` in `scraper/lib.ts`) and
the drafter's system prompt (`profileBlock` in `server/utils/drafter.ts`) are built from the row at run time,
so editing Settings changes the next scrape and the next draft.

`shared/settings.ts` is the single definition: the Zod schema, `EMPTY_SETTINGS`, and the two SQL statements.
It is pure — Zod only, no `node:fs`, no `better-sqlite3` import — so the server, the scraper child process,
the tests and the browser's types all read the same file. `server/utils/config.ts` is the server's view of it
and keeps the old `readConfig` / `readConfigRaw` / `writeConfig` names.

- `profile` — name, title, location, email, phone, LinkedIn, GitHub, languages, years.
- `constraints` — `remoteAnywhere`, `onsiteCountries`, `willRelocate`, `canStartImmediately`, `workingHours`,
  `stackWeighting` (`vue-primary` | `equal` | `react-primary`).
- `cv` — repo-relative path under `data/cv/`, written by the upload endpoint rather than typed. The scoring
  model reads the PDF itself once per run (`input_file`); no PDF library.
- `terms` (the home feed plus 8 searches), `titles` (30, for the scoring prompt), `max`, `since`.
- **`.env`** — `OPENAI_API_KEY`; optionally `JOBFINDER_DB`, `JOBFINDER_MODEL`, `PROFILE_DIR`. Loaded with
  Node's `--env-file-if-exists`. Never write the key into a tracked file.

**Two schemas, not one, and the split is load-bearing.** `settingsSchema` checks shape and format only and
lets every field be empty, because a fresh install has to be able to save a half-filled form — you cannot
upload a CV to fix an incomplete config if the incomplete config is what blocks the save. `missingFields()`
plus `assertComplete()` in `server/utils/config.ts` are the separate run gate: `readConfig()` calls them, so a
scrape or a draft still refuses to start on an incomplete config, with a readable line per problem.
`readConfigRaw()` and `readConfigLoose()` never throw — the Settings page and the Gmail status card render on
that page and have to load in order to *fix* the thing that is wrong.

**Countries come from a bundled ISO 3166 list** (`shared/countries.ts`, ~198 entries with aliases), not from
LinkedIn. Country names never reach a LinkedIn URL — they are prose inside two prompts — and LinkedIn
publishes no country-list endpoint, so fetching one would mean extra authenticated requests against the same
account the scraper rate-limits. The aliases are the point: `withAliases()` renders `UAE (United Arab
Emirates, Emirates)` into the scoring prompt so the model matches whatever form the post text uses, and
`tldsFor()` derives the `.eg .sa .ae .qa` email-domain hint that used to be hardcoded. `profileBlock` in the
drafter deliberately keeps the plain join — alias parentheses would leak into email prose.

**Onboarding a fresh install:** open Settings, drop the CV on the upload area, press **Prefill from CV**. The
model reads the PDF and fills only the fields that are still empty; it is never asked for
`onsiteCountries`, `willRelocate`, `workingHours` or the switches, because a CV cannot know them and a model
asked for them invents an answer that then goes out in an email. Nothing is saved until you press Save.

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
- **The post permalink is recovered from the network, not the DOM.** LinkedIn strips URNs from the rendered
  HTML; the only id on a card is `expanded<token>FeedType_...`, whose token is an opaque hash. The URNs are
  still in the React-server payloads that render the page, so `scrapeTerm` reads response bodies passively
  (no extra request) and `urnMap` in `scraper/lib.ts` pairs token to URN: **in a search payload the URN
  immediately before a card's `UpdateState<token>` key is that card's own.** Measured, not assumed — the
  obvious "nearest URN" rule was tried first and mapped every card on a page to one URN.
  **The home feed cannot be resolved at all**: it packs every `UpdateState` key into one consecutive array
  with the URNs elsewhere, so `term === 'feed'` deliberately stores no URL rather than a wrong one. The same
  reasoning drives `resolveUrls`, which drops any URN two cards both claim — a permalink pointing at the post
  *next to* the job is worse than none. Verify with `npm run dry`, which prints the URL per card.
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

### Settings

- **The CV upload writes behind the Settings form's back.** `PUT /api/config` sends the whole form object, so
  after `POST /api/settings/cv` the page must re-sync *both* the form and the dirty baseline from the
  response. Without that, the next Save posts the pre-upload `cv` path and silently overwrites the file
  reference that was just stored — leaving the scraper pointing at a CV that is not there.
- **The Settings page's dirty check is `JSON.stringify(form) !== JSON.stringify(data)`, which is key-order
  sensitive.** `EMPTY_SETTINGS` defines the key order and the server hands back what it was given; rebuilding
  the object with a different order makes the page permanently dirty.
- **`UInputTags` does not trim.** Duplicates it rejects on its own (`duplicate` defaults false), but
  whitespace reaches the schema, so `save()` trims `terms` and `titles` on the way out.
- **`UInputMenu multiple`, not `USelectMenu multiple`, for the country pickers.** Only the former wraps reka's
  `TagsInputRoot` and draws deletable chips inside the input; `USelectMenu` renders the selection as joined
  text.
- **`readConfig()` throws on an incomplete config and that is deliberate** — but it means every caller on a
  path that must survive a fresh install has to use `readConfigLoose()` / `readConfigRaw()` instead.
  `server/tasks/daily.ts` is the one that bit: the strict read there would have cost the nightly backup.
  Watch for `''` versus `undefined` too — `gmail/status.get.ts` used `?? null`, which passes an empty string
  straight through and fires the account-mismatch banner against a blank address.

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

## Gmail (M4)

- **Nothing can send.** `gmail.compose` includes permission to send, so never-sending is a property of this
  code: no `messages.send` / `drafts.send` call may exist under `server/`, and `test/invariants.test.ts`
  fails if one appears. Drafts are created addressed and attached; you press send.
- **Scopes: `gmail.compose` + `gmail.readonly`.** The sweep searches sent mail with `q=`, which the narrower
  `gmail.metadata` scope rejects outright.
- **The callback checks a one-shot `state` nonce before touching the code.** Google's redirect into
  `/api/gmail/callback` is itself a cross-site GET, so an Origin / Sec-Fetch-Site guard must exempt GETs and
  cannot protect it; without the nonce any page open in the browser could hand the server its own code and
  have the drafts written into its mailbox. Ported from upstream `e8be7b6`. Verify: a forged callback returns
  400 and `gmail-token.json` is untouched. The nonce lives on `globalThis` so an HMR reload mid-consent does
  not break the round trip.
- **The CV is attached at creation**, in the same call. The original had to re-open every draft afterwards
  because the MCP tool corrupted base64 passed through the model; here the bytes are read from disk by the
  server and never touch a model. `createDraft` re-reads the draft and reports the attached byte count — a
  draft that logs `NO CV ATTACHED` means the PDF path is wrong.
- **`renderHtml` emits real anchors.** Gmail rewrites bare URLs in a plain-text body into `google.com/url?q=`
  redirects; two applications went out that way on the original.
- **The stage machine is a pure function** in `server/utils/stages.ts` — the original's 8-row table in code,
  with a test per row. Order matters: a bounce or an auto-reply must never be read as a human reply, or a
  live application stops dead. Silence is 72 hours from the last outgoing message.
- **Gmail is the truth about what was sent; `contacts` only caches the stage.** A draft is not a contact
  until you send it. Run a sweep after sending.
- **`drafts` are not returned by `messages.list`, even with `in:draft`** — pending drafts are found with the
  `drafts` endpoint. Trusting the search once nearly produced a duplicate.
- **The connected account is discovered, not hardcoded.** The sweep matches sent mail by sender, so the wrong
  account would make every sent application look unsent. Settings shows a warning when the connected address
  differs from the stored settings.
- **Daily housekeeping** is a Nitro scheduled task (`server/tasks/daily.ts`, `7 8 * * *`) replacing the
  launchd plist: a dated `.db` copy in `backups/` (newest 14) and a queued sweep, so follow-ups fire without
  anyone remembering. It only runs while the dev server is up — the same constraint the original had. Run it
  by hand with `curl -X POST http://127.0.0.1:3939/_nitro/tasks/daily`.

**Setting Gmail up:** a Google Cloud project with the **Gmail API enabled on the project that owns the
client**, consent screen **In production** (in Testing, refresh tokens die after 7 days), an OAuth client of
type **Desktop app** (which has no redirect URI field — loopback is permitted automatically), downloaded as
`google-oauth.json` in the project folder. The app listens on `http://127.0.0.1:3939/api/gmail/callback`;
`localhost` is deliberately avoided because it resolves to `::1` first while the dev server binds IPv4 only.

**The full walkthrough, with every trap the Console throws, lives in two places that must stay in step:**
`SETUP.md` ("Connecting Gmail") and `app/components/GmailSetup.vue`, which Settings shows when
`google-oauth.json` is missing. The four traps, in order: the post-enable "Create credentials" banner can
build a **service account**, which cannot reach a personal Gmail at all; **Publish stays greyed out** until
Branding is complete; publishing to production **demands a real homepage and privacy-policy URL**; and a
Desktop client **has no redirect URI field**, so its file says `["http://localhost"]` while the app calls
back on a different host, port and path — which Google accepts.

## Known gaps

- The **Google round trip has never run** — token exchange, refresh, real draft creation, a real sweep are
  written and unit tested but untested against Google, because `google-oauth.json` does not exist yet.
- The **Usable** KPI counts `score >= 6 AND no flags AND (in_scope OR remote)`, so a strong role whose post
  never states a location is missing from the headline number. It still appears in the Posts list.
- **`resolveUrls` only dedupes within one search term**, and nothing constrains `post_url` to be unique, so a
  post mispaired under one term and paired correctly under another would keep both rows' URLs. Not observed —
  the search-path rule resolved 26/26 cards uniquely across the runs that established it.
- **Posts scraped from the home feed carry no permalink**, and neither do rows stored before `post_url`
  existed until a search re-encounters them (the scraper emits `op:'posturl'` for a post it already knows,
  which is the only backfill path — a re-scrape skips known posts before scoring, so the insert's own
  `ON CONFLICT` backfill never fires during a normal run).
- **No repair path for a draft created with a wrong CV path.** The CV is attached at creation and the byte
  count verified, so the fix is to delete the Gmail draft and re-run rather than retrofit it.

## Never commit

`profile/` (a live LinkedIn session), `.env`, `data/` (the database, the CV and drafts), `config.json`
(retired, see below), `google-oauth.json`, `gmail-token.json`, `backups/`, `logs/`, `jobs.csv`. `.gitignore`
covers all of them — verify with `git check-ignore <path>` rather than by eye, and note that a trailing-slash
pattern only matches a directory that already exists.

**The git remote is `git@github.com:shaltut/job-finder.git` — the original author's repository, not
Mohamed's.** Confirm the remote before pushing. Retiring `config.json` took the phone number and email out of
the *code*, but **`docs/superpowers/specs/2026-09-10-nuxt-rewrite-design.md` still quotes them** (the config
example at ~line 198 and the injected-identity paragraph at ~line 259) — it is a design record from before the
move. Scrub it or drop the file before this repo goes anywhere public.
