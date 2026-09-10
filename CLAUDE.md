# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ahmed's personal job-search pipeline, built 2026-09-06. It scrapes LinkedIn **posts** (not the Jobs tab) — content
search plus, since 2026-09-10, Ahmed's own home feed — for roles that carry a contact email, scores each post against his CV, stores everything in a local Postgres
database, drafts tailored application emails as Gmail drafts, follows up once after three days of silence, and
then stops contacting that recruiter. Sending is always manual: Ahmed attaches the CV and presses send.

Target: engineering leadership and senior .NET / architect roles, remote or in MENA (Saudi, UAE, Qatar, Egypt).
Remote roles from India-based employers are in scope since 2026-09-08 (no office days, Cairo-compatible hours);
on-site or hybrid outside the Gulf and Egypt is not. Personal recruiter addresses (gmail etc.) are treated like
company addresses. Both are Ahmed's explicit decisions; the skill file encodes them.
The full decision history is in `docs/superpowers/specs/` (two specs) and `docs/superpowers/plans/`.

## The pipeline, end to end

```
npm start  ──►  posts (Postgres)  ──►  /job-application-drafter  ──►  Gmail drafts  ──►  Ahmed sends
jobfinder.js     scored vs CV           .claude/skills/...           applications +      (CV attached by hand)
(Playwright +    dedupe on key          headless or in-session      contacts tables
 OpenAI)                                                                  ▲
                          ui.js / ui.html on 127.0.0.1:3939  ───────────────┘  (browse, act, run both)
```

1. **Scraper** `jobfinder.js`: drives the installed Chrome (`playwright-core`, `channel: 'chrome'`, headed, its
   own profile in `./profile`) through LinkedIn content search, one term at a time (the literal term **`feed`**
   scrapes `linkedin.com/feed/` instead — same cards, same loop, no `datePosted` filter), scrolls until the card count
   stops growing, expands "… more", keeps posts whose text contains an email, sends survivors to OpenAI
   (`gpt-5-nano`, Responses API, strict JSON schema) with the CV text in the prompt, inserts into `posts`.
2. **Drafter skill** `.claude/skills/job-application-drafter/SKILL.md`: screens a post (hard skips, soft flags),
   checks the recruiter's stage in `contacts` and in Gmail, writes an honest email that declares gaps, saves it as
   a Gmail draft, records verdicts. It is the source of truth for Ahmed's profile facts, gap list and constraints.
3. **UI** `ui.js` + `ui.html`: sidebar dashboard (Posts, Pipeline, Run, Settings) with a KPI strip, a global job
   bar with Stop on every view, row-level Skip/Draft, pipeline stage badges with follow-up countdowns, Sync with
   Gmail, and the settings editor for `config.json`. Runs the scraper and the headless drafter (`claude -p` with
   an allow-list). Visual rules come from `design-system/job-finder/MASTER.md` (ui-ux-pro-max, "Data-Dense
   Dashboard"): tokens at the top of `ui.html`, Fira Sans/Fira Code from Google Fonts with system fallback (offline
   it just falls back), inline SVG icons, light and dark via `prefers-color-scheme`. `[hidden]{display:none!important}`
   is load-bearing: the `.view` flex rule would otherwise override it.

## Commands

```bash
npm start                                   # scrape + score with config.json defaults
npm start -- --terms "hl7 fhir,solution architect" --max 20 --since past-week --cv ~/Documents/Other.pdf
npm start -- --rescore                      # rescore every stored post (after a CV or prompt change)
npm start -- --reflag                       # recompute pre-screen flags for every stored post (no API)
npm run dry -- --terms "engineering manager" --max 10   # scrape one term, print cards, no OpenAI, no DB
npm run login                               # one-time LinkedIn login into ./profile (redo when runs exit 2)
npm test                                    # self-test of helpers (no browser, no DB, no API)
npm run ui                                  # http://127.0.0.1:3939
./scrape.js --since past-week               # or: npm run scrape -- --since past-week
                                            # starts the UI if it is down, queues a scrape in its lane, follows the log
npm run schedule / npm run unschedule       # optional launchd daily 08:00 with 0-30 min jitter; off by default
/opt/homebrew/opt/postgresql@15/bin/psql -d jobfinder   # psql is NOT on PATH (keg-only Homebrew)
PROFILE_DIR=profile-empty npm run dry       # proves the login guard: exits 2 with "login expired"
```

The drafter is a skill, not a script: run `/job-application-drafter` in a session started in this folder ("process
the top 10 unprocessed posts", or a pasted posting), or press Run drafter in the UI.

## Data model (Postgres `jobfinder`, Homebrew postgresql@15, trust auth, user `ahmedshaltoot`, no password)

- `posts.flags text[]` — regex pre-screen mirroring the skill's hard skips (`residency-gate`, `junior`,
  `junior-years`, `immediate-start`, `night-shift`). Personal email addresses (gmail etc.) are deliberately not
  a flag and not a skip: Ahmed's decision on 2026-09-08, since much real Egyptian and Gulf recruiting runs on them. Hints only: the drafter confirms them in the text;
  the UI and the drafter's queue sort flagged posts last. Rules live in `FLAG_RULES` in `jobfinder.js`.
- `posts` — one row per scraped post. `key` = sha1(author_url + first 160 chars of text with the drifting header
  markers stripped: age like `5h`/`1d`, Follow/Following, Edited, connection degree). `score` 0-10 and `reason`
  are model output against the CV: **ordering hints only, and `reason` overclaims** (it has credited Terraform
  and HL7 V2 that Ahmed lacks). `emails text[]` comes from a deterministic regex, never from the model.
- `applications` — one row per post touched by the drafter or the UI: `verdict` drafted|skipped, `reason`.
  Reasons for drafted posts start with `named in application` / `named in follow-up`; the follow-up query relies
  on that prefix. A post with a row is never shown as unprocessed again.
- `contacts` — one row per recruiter email: `stage` drafted → contacted → followed_up → final, or replied.
  Gmail (sent mail) is the truth for "contacted"; the table only caches the stage. `final` is never reset.
  Two emails per address, ever. Stages only move when the skill's **stage sweep** runs (Step 1a, at the start of
  every drafter run, or alone via the Pipeline tab's "Sync with Gmail" button / `POST /api/run/sync`). Sending a
  draft does not update the page by itself; sync after sending.

All three tables come from `schema.sql`, applied idempotently by both `jobfinder.js` and `ui.js` at startup (the
skill file carries a copy for reference only). `contacts.email` must be lower-case (constraint) and the skill's
upsert carries `WHERE contacts.stage <> 'final'`, so `final` is enforced by the database.

## Configuration

- `config.json` — `terms` (the home feed plus 8 search terms), `titles` (30 target titles for the scoring prompt), `max` cards per
  term (40), `since` (past-24h | past-week | past-month). Edited from the UI's Settings tab. CLI flags override.
  The terms were tuned on 2026-09-07 from one day of data: `engineering manager`, `head of engineering`,
  `health insurance technology`, `ai engineering manager` were dropped (74 posts, 1 usable) and `hiring .net`,
  `technical lead .net`, `engineering manager saudi`, `backend lead` added. Re-check yield with:

  ```sql
  select search_term, count(*) posts, count(*) filter (where score >= 6 and coalesce(cardinality(flags),0) = 0
    and (mena or remote)) usable from posts group by 1 order by usable desc;
  ```
- `.env` — `OPENAI_API_KEY`; optionally `DATABASE_URL` (default `postgres://localhost/jobfinder`). Loaded with
  Node's `--env-file-if-exists`, no dotenv. Never write the key into this file for Ahmed; he does it himself.
- `jobfinder.js` config block — `MODEL`, `CV_PATH` (default `~/Documents/AhmedShaltootCV1.pdf`), `MENA` list,
  the OpenAI `systemPrompt`. The CV PDF is read by the model itself once per run (`input_file`), no PDF library.
- The skill file holds Ahmed's profile facts, evidence, gap list, relocation and level constraints as a snapshot
  dated 2026-09-06. If the CV changes, update the skill's Steps 3-5 too, or drafts keep hedging on stale gaps.
- `ui.js` — `DRAFT_ALLOW` / `DRAFT_DENY` for the headless drafter, run with `--permission-mode dontAsk`. **The
  headless run inherits the user-level allow list in `~/.claude/settings.local.json`** (it accumulates
  `Bash(curl:*)`, `Bash(rm:*)`, `Bash(echo:*)`, `Bash(npm:*)` ... from past approvals), and neither `dontAsk` nor
  `--permission-prompts none` overrides an allow rule. Deny rules do, so `DRAFT_DENY` lists the shell prefixes and
  every sending tool; only `Bash(/opt/homebrew/opt/postgresql@15/bin/psql:*)` is allowed, which is why the skill
  must call `psql` by its literal full path. When new prefixes get approved at user level, extend the deny list.
  Probe it with a `claude -p` that tries psql, curl and echo; only psql should run.

## Gotchas (each cost real time)

- **Do not add `contentType=["jobs"]` to the LinkedIn search URL.** It means "posts embedding a Job card" and
  returns almost nothing with no emails. Only `datePosted` is used.
- **LinkedIn's DOM has hashed class names and no post URN.** Cards are found structurally (the container whose
  children each hold an author link) and read via `innerText`. The results live inside a scrolling `<main>`;
  scroll with `page.mouse.wheel`, not `window.scrollTo`. Emails render as `mailto:` links.
- **Locale is pinned to en-US** in the scraper, but it does not hold: LinkedIn renders the first ~10 cards of any
  page server-side in the *account's* language (Arabic) and the scroll-loaded ones in English. `normalize()` folds
  the Arabic age back into its English form (`٣ من الساعات` → `3h`) before the age regex or the dedupe key see the
  text, so those cards no longer land with a NULL `posted_at` and a key that drifts as the post ages. The two
  render paths still key the same post twice — both copies sit in the DOM at once, and which path serves a given
  post changes between runs, so a post scored yesterday can come back with a fresh key today (the `ponytail:` note
  on `normalize()` names the fix: map the wrapper words, strip the RTL marks). Rare enough to leave alone: 2 extra
  rows in 515 on 2026-09-10, one of them cross-run. The email is identical either way, so no recruiter is
  contacted twice.
- **The feed's reposts name the wrong author** unless you look: a card opening with "X reposted this" links X
  first, so keying on the first link stores one row per resharer. `readCards` picks the **most repeated** href
  instead — the real author is linked three times (avatar, name, menu), a resharer twice.
- **The drifting-header dedupe bug:** the first key included "21h", so the same post came back as "22h". Anything
  added to the key must be stable across runs.
- **Rate-limit posture:** 9 terms (the feed plus 8 searches), 40 cards, randomized pauses, headed Chrome, `--enable-automation` off. A
  LinkedIn checkpoint page is treated as a lost login (exit 2, `login expired` in `logs/err.log`, nobody is
  notified). Fix with `npm run login`. Avoid running many manual scrapes on one day.
- **Two job lanes and a queue** in `ui.js`: the scrape lane (one at a time, Chrome profile lock) and the draft lane
  (drafter runs and syncs, one at a time) run concurrently; everything else queues (`POST /api/run/*` returns 202
  and never 409). Single-post Draft requests waiting in the queue are batched into one `claude -p` session, since
  each session costs 3-5 minutes of setup regardless of post count. `GET /api/job` returns `{lanes, queue}`;
  `POST /api/job/stop {lane}` and `POST /api/queue/:id/cancel`. The daily sync just enqueues. Stop sends SIGTERM; Playwright's own handler only closes Chrome, so
  `jobfinder.js` keeps a `stopping` flag and throws `stopped` at the next loop check (exit 1, notification says
  failed). Scoring failures are not stored any more: the post is retried on the next run instead of sitting with
  a NULL score.
- **The API refuses cross-site and wrong-Host requests** (Origin / Sec-Fetch-Site / Host checks in `route()`),
  validates `n` for drafter runs, and Skip cannot overwrite a `drafted` verdict (409). Local `curl` is unaffected.
- **Postgres on this Mac broke once** (`dyld: libicui18n.73.dylib` missing after a Homebrew upgrade); fixed with
  `brew reinstall postgresql@15`. It was also simply not running on 2026-09-08 (clean log, no crash), fixed with
  `brew services restart postgresql@15`. If `npm start` or `npm run ui` says the database is not ready, run
  `pg_isready` and read `/opt/homebrew/var/log/postgresql@15.log` before anything else. Other Postgres containers on this Mac (5433,
  `tactai-pg`) belong to other projects.
- **A macOS notification** ("Job Finder") fires at the end of every non-dry scrape with the row count, or
  `failed: login expired`, and after each automatic daily sync with the report's first line. There is no email or push.
- **Daily housekeeping lives in `ui.js`** (`dailyTick`, hourly check, state in `logs/daily.json`): once a day while
  the UI is up and idle it runs the Gmail stage sweep (so follow-ups fire without anyone remembering) and writes a
  dated `pg_dump` to `backups/` (newest 14 kept). Nothing runs when the UI server is down. At startup, if Postgres
  is unreachable, `ui.js` runs `brew services start postgresql@15` once and retries for 20 s.
- **`posts.posted_at`** is computed from LinkedIn's relative age at scrape time (`postedAt()` in `jobfinder.js`;
  `--reflag` backfills it) and is the secondary sort in the Posts view. `GET /api/yield` and the Run view's
  "Yield by search term" table replace the psql query for term tuning.
- **Scoring prompt credits only what the CV text contains** (rule added 2026-09-08 after the `reason` column
  credited Terraform and HL7 V2 twice); `reason` is now "Match: …; Gaps: …". Rescore after any prompt change.
- **Headless drafter (`claude -p`)** sees the Gmail MCP tools and the project skill only when started from this
  folder with the CLI on PATH. Its stdout is the final report only, so the UI log is empty for 3-5 minutes.
- **CV attachment is done by `ui.js`, not by the model.** The Gmail MCP tool takes base64 in the call parameters,
  which corrupts a 75 KB PDF. `ui.js` uses the Gmail REST API (OAuth Desktop client in `google-oauth.json`, tokens in
  `gmail-token.json`, both gitignored, scope `gmail.compose`, never calls send): after every drafter or sync run,
  and from the Pipeline view's button, it lists drafts addressed to recruiters in `contacts`, rebuilds the ones
  without a PDF with the file bytes, updates them in place, and verifies the attachment size. Only recruiters at
  stage `drafted` or `followed_up` are touched (drafts listed with `q=to:<email>`), so hand-written mail to replied
  or final recruiters is never rewritten; PDF presence is judged by MIME type, not by any filename. If Google shows the
  OAuth app as "Testing", refresh tokens die after 7 days; set publishing status to In production.
  The OAuth client lives in Google Cloud project `jobfinder-507910` (personal account); **the Gmail API must be
  enabled on the project that owns the client**, or every call fails with "Gmail API has not been used in project
  <number>". gcloud cannot create the consent screen or a Desktop client (IAP brand API needs an org and is shut
  down), and Google blocks its own gcloud client from the Gmail scope, so `gcloud auth application-default login
  --scopes=gmail.compose` is a dead end. The isolated gcloud config for the personal account is
  `CLOUDSDK_CONFIG=~/.config/gcloud-jobfinder`; `jobfinder-260907` is an unused leftover project.
- **Gmail rewrites bare URLs** in plain-text drafts into `google.com/url?q=` redirects; two applications were sent
  that way. The skill now sends an `htmlBody` with real anchors for the signature links. Still glance at the
  signature before sending.
- **`search_threads` never returns drafts**, even with `in:draft`. Pending drafts are confirmed with `list_drafts`
  or `get_draft` on the stored `gmail_draft_id`.
- **The Claude-in-Chrome extension cannot open localhost**; verify the UI with Playwright screenshots
  (`chromium.launch({ channel: 'chrome', headless: true })` from this folder's `node_modules`).
- **Git repository since 2026-09-10** (it was deliberately not one before, when nothing left this Mac). Never
  commit `profile/` (a live LinkedIn session), `.env`, `google-oauth.json`, `gmail-token.json`, `backups/`,
  `logs/`, `drafts/` or `jobs.csv` (scraped recruiter addresses) — `.gitignore` covers all of them. `SETUP.md` is
  the handover doc for anyone else running this; it carries the list of things that must be swapped, starting with
  the drafter skill's profile facts and identity block.

## Conventions in this codebase

Single-file tools, no framework, no build step, dependencies limited to `playwright-core`, `openai`, `pg`. Node
22 built-ins for everything else (`parseArgs`, `--env-file-if-exists`, `node:http`). Deliberate ceilings are
marked with `ponytail:` comments. Each non-trivial change ships with one runnable check (`npm test`, a curl, or a
dry run) rather than a test suite. Specs and plans under `docs/superpowers/` are the design record; update the
spec when a decision changes.
