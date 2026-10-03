# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

A personal job-search pipeline, for whoever runs it. It scrapes LinkedIn **posts** (not the Jobs tab) —
content search plus the account's own home feed — for roles that carry a way to reach the poster, scores each post
against the owner's CV, stores everything in a local SQLite database, and drafts tailored application emails.
Sending is always manual.

**Single-tenant, and deliberately so.** Each person clones the repo and runs their own copy: one settings row
(`CHECK (id = 1)`), one Chrome profile, one Gmail token, one CV. There is no auth and no accounts, and the
server binds to `127.0.0.1`.

**Nothing in the source names a profession, a country or a person.** The target — field of work, skills,
seniority floor, countries, target titles — is the `settings` row, and `test/identity.test.ts` fails the
build if the owner's own name, email, phone or handles appear in any tracked file. Personal recruiter
addresses (gmail etc.) are treated like company addresses: much real recruiting, in many markets, runs on
them.

**`main` carries the Nuxt rewrite** — not the original Node + Postgres + vanilla-JS version; feature
branches, this one included, branch from and merge back into `main`. The design record, including what
changed during implementation and the known gaps, is `docs/superpowers/specs/2026-09-10-nuxt-rewrite-design.md`;
the two `2026-09-06-*` specs beside it describe the pre-rewrite system.

**The rewrite is complete (M1-M5), and Gmail is connected** — `google-oauth.json` and `gmail-token.json`
both exist and `/api/gmail/status` reports the account authorised. On a machine without them, drafts fall
back to `data/drafts/*.json` and everything else works unchanged.

The pre-rewrite implementation (`jobfinder.js`, `ui.js`, `ui.html`, `scrape.js`, `schema.sql`,
`com.jobfinder.plist`) is **deleted here but preserved in git** — read one with `git show e2ab7c1:ui.js`, the
M4 commit just before M5 deleted them (`main` no longer carries them, so `main:ui.js` no longer resolves).
Source comments that mention those files are historical attribution, not live references.

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
   card count stops growing, expands "… more", keeps posts offering a contact route the owner switched on
   in Settings (`contactChannels`, email-only by default), sends survivors to
   OpenAI (`gpt-5-nano`, Responses API, strict JSON schema) with the CV text in the prompt.
   **It never writes the database.** Pure helpers live in `scraper/lib.ts` so the server and the tests share them.
2. **Ingest** `server/utils/ingest.ts`: the one place scraper output becomes rows. Used by the server (which
   spawns the scraper from the UI) and by `scraper/ingest.ts` (the CLI pipe), so both behave identically.
3. **Drafter** `server/prompts/drafter-procedure.md` + `server/utils/drafter.ts`: the server picks
   the posts, groups them by recruiter, and runs one `claude -p` session per recruiter with **no tools at
   all**. The skill returns JSON only. The server validates it, writes the email, and records the verdicts.
4. **UI** `app/`: Nuxt UI v4 dashboard — Posts, Pipeline, Run, Settings. The Posts view is a grid: sort and
   filters live in the column headers (`PostsHeaderCell`), the whole view is in the URL
   (`shared/posts-view.ts`, so refresh and back keep it), sorting is server-side (`orderSql()` in
   `server/utils/posts-query.ts`, flagged last under every sort), and shift-click selects a range for the
   bulk bar (`PostsBulkBar`: Draft, Applied, Dismiss, Exclude…). Row actions sit **beside the checkbox**,
   not at the right edge — the owner reads the title and acts on the same row. The country filter maps the
   model's free-text `location` through `countriesIn()` in `shared/countries.ts`, and the **Location**
   column shows `placeOf()` from `shared/place.ts` (country + flag, one-spelling city, region, and the work
   model from the location, then the `remote` flag, then the body — hybrid/on-site only, marked "from post
   text"), computed per page in `posts.get.ts`, never stored. Measured 2026-10-03 over 2,037 hiring posts:
   1,703 resolve to one country and 315 to none, 238 of which say only remote/unknown/nothing. Its city,
   region and **Arabic-name** tables are **filter/display-only**: they must never reach `withAliases()` or
   a prompt (Arabic names are deliberately not aliases for that reason). Never infer a country from an
   email domain or phone code — measured, they named the agency's country in 20 posts.
5. **Paste intake** `server/api/posts/paste.post.ts` + `server/utils/paste.ts` / `paste-job.ts`: a post that
   arrived by email or WhatsApp, pasted into the Posts view (`app/pages/index.vue`). The endpoint runs the
   same extraction and contact-route gate a scrape runs — pure regex, so a refusal is immediate — and queues
   only the OpenAI score, onto a **third job lane**. An incomplete config refuses the same way `readConfig()`
   always has: 422 with `{ error }` carrying its own message (`Settings are incomplete —
   constraints.workingHours: not set`), not a per-field `missing` array. The row it writes is an ordinary
   one: `search_term = 'pasted'`, `author` / `author_url` / `post_url` null, and **no exemption anywhere
   downstream that decides who receives an email** — a pasted post that scores 4 does not draft, exactly
   like a scraped one. The KPI strip's two scrape figures (`last24h`, `lastScrapeAt` in
   `server/api/stats.get.ts`) are the one consumer that reads origin, because they measure the scraper
   rather than the inbox, and exclude `search_term = 'pasted'` for exactly that reason. The orchestration
   (`pasteOnce`) takes the CV system prompt, the score call and the store as injected dependencies rather
   than living in `server/utils/jobs.ts`, which no test in this repo can import (it pulls in the drafter,
   Gmail, sync and the CV modules); three successive source-text assertions over the old inline version each
   passed the previous one's regex under a new idiom for swallowing a failed score before this shape replaced
   them, and three source-text assertions over `paste-job.ts` still remain in `test/paste.test.ts`, each
   guarding an edge a runtime test on `pasteOnce` alone cannot see: one pins that `runPasteJob` actually
   delegates to `pasteOnce` (`/return pasteOnce\(/`) rather than reimplementing it inline — solid, no known
   false pass or false alarm; one pins that `scorePost` is injected bare (`/score: scorePost,/`) rather than
   wrapped in something that could absorb its own failure — real, but it false-positives on a semantically
   identical reorder of the same object literal that drops the trailing comma, so a failure here is as
   likely to be a harmless edit as a regression; one pins that `runPasteJob`'s body calls neither `catch`
   nor `.then(` at all (`/\bcatch\b|\.then\(/` over the slice from its export to end of file) — anchored on
   the function's own export and on that export staying the file's last one, both checked before slicing,
   so renaming the export or appending a later one fails an anchor assertion instead of the vacuous pass an
   earlier version of this pin had, where an unchecked `indexOf` returning -1 made the slice run over the
   file's last byte only.

## Commands

```bash
npm run dev                                  # http://127.0.0.1:3939 (port pinned, see gotchas)
npm test                                     # helpers, settings, ingest, dismiss, drafter, background, stages, MIME, invariants, identity
npm run lint / npm run typecheck
npm run login                                # one-time LinkedIn login into ./profile (redo when runs exit 2)
npm run dry -- --terms "<a term from Settings>" --max 10  # cards + contact routes, stores nothing, no OpenAI call
node scraper/run.ts | node scraper/ingest.ts # CLI scrape; normally you press Start scrape in the Run view
npm run db:generate && npm run db:migrate    # after editing server/db/schema.ts
node scripts/screenshot.mjs [outDir]         # screenshots every view (see the localhost gotcha)
sqlite3 data/jobfinder.db                    # macOS ships sqlite3 at /usr/bin/sqlite3
sqlite3 data/jobfinder.db 'select json from settings'   # the settings that replaced config.json
```

`--rescore`, `--reflag` and `--reextract` all *update* existing rows, which the read-only scraper cannot
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

- **`posts`** — one row per scraped post. `key` = sha1(author_url + first 160 chars of the post **body**
  with drifting header markers stripped) — the body being whatever follows the card's Follow marker, or
  the whole text when a card carries none. `post_url` is the permalink, null when the run could not resolve one — see the
  URN gotcha below. `score` 0-10 and `reason` are model output against the CV: **ordering hints only,
  and `reason` overclaims** — never copy it into an email. `emails`, `links`, `phones` and `ref_ids` all come
  from deterministic regexes, never from the model. `in_scope` (was `mena`) means Egypt/Saudi/UAE/Qatar or genuinely location-free remote.
  `post_type` is `hiring` | `seeking` | `other` — **who is posting**. Only `hiring` is a job; `seeking` is
  another developer advertising themselves and `other` is not a job post at all. NULL means the row was
  scored before the column existed, so every consumer reads `coalesce(post_type, 'hiring')` — without that
  the migration empties the UI until a rescore finishes. `--rescore` is the only path that fills it.
- **`posts.search_term`** — `'pasted'` marks a post that entered through the paste box rather than a search.
  It is its own bucket in the per-term yield table, so pasting never inflates a real search term's numbers.
- **`posts.flags`** — pre-screen hints mirroring the skill's hard skips, produced by `prescreen()` in
  `scraper/lib.ts`. Three static regex rules in `FLAG_RULES` (`residency-gate`, `night-shift`,
  `seeking-work`), plus everything `flagRules(config)` derives from the settings row — `junior` above a
  seniority floor of 3, the country half of `residency-gate`, the time-zone half of `night-shift`, and
  **`excluded`** — plus `junior-years`, which comes from a separate years-of-experience check and is in
  neither table. Hints only; the drafter confirms them in the text, and the UI hides flagged posts
  by default. **The drafter queue excludes them outright** rather than sorting them last — pinned by
  `test/invariants.test.ts`, because `excluded` makes that predicate a user-facing promise.
  **Every derived rule fails open**: an unset setting yields no rule rather than a broad one, since a
  false positive costs a lead while a false negative only costs a sort position.
  **`immediate-start` is deliberately absent** — whether an immediate start is a problem depends on the
  candidate, not the posting, and the drafter already states the real availability from
  `constraints.canStartImmediately`.
  **`seeking-work` must stay first-person** (`I'm #OpenToWork`, `I am actively seeking`, `Services I offer`).
  The scored text includes the LinkedIn card header, so a bare `/open to work/` also matches the *headline*
  of a recruiter who happens to be job hunting — one stored row is a genuine DecipherZone req posted by
  someone whose headline ends `| Open to Work`. Run the rule over the stored posts before changing it: it
  must fire on exactly the three seeker rows of **`backups/pre-wipe-2026-09-13.db`** and nothing else — the
  live database was wiped and re-scraped, so it no longer contains that corpus (measured: 3 hits in the
  backup, 0 live).
- **`excluded`** — the one flag the owner writes themselves, from the `excludes` settings list via
  `excludeRule()` in `scraper/lib.ts`. It is the deterministic counterpart to `scope.excludedRoles`,
  which is only prose the scoring model is *asked* to honour — the same reasoning that put
  `gateOnPostType()` in code. Matched against the whole post text, which begins with the LinkedIn card
  header, so one list covers a domain in the prose, a company name and a recruiter's name.
  **Word boundaries are not optional and are conditional on the needle's own edges.** Measured over the
  42 stored posts: bare `ai` matches 36 of them and 9 with boundaries, `intern` 12 and 7, `micro1.ai` 2
  either way. But `\b` is ASCII-only in a JS regex, so a boundary is added only where the edge character
  is one `\b` can see — wrapping `C#` or an Arabic needle would stop it matching at all. Needles are
  escaped literals, never patterns. Changing it to a substring match would empty the queue; re-measure
  against the stored corpus first.
  **It hides, it never deletes.** Deleting a rule and re-flagging brings the posts back, which is why
  this is a flag rather than an admission-time drop or a `dismissed_at` write.
- **`posts.dismissed_at`** — the owner's own triage from the Posts view, written by
  `POST /api/posts/dismiss` (the one endpoint that writes a post row) through `setDismissed()` in
  `server/utils/ingest.ts`. NULL means live. It is **orthogonal to `applications`**, not a third verdict:
  a drafted post can be dismissed too, and un-dismissing is the same call with `dismissed: false`.
  Three queries carry `dismissed_at IS NULL` and an invariant test says they must — the drafter queue and
  its single-key sibling in `server/utils/jobs.ts`, and the follow-up sweep in `server/utils/sync.ts`,
  which finds unmentioned roles by the *absence* of a `named in ...` row and would otherwise treat every
  dismissed post as fair game. `usable` and `unprocessed` exclude them; `total` and `last24h` do not,
  because those measure the scrape rather than the triage. A dismissal survives a re-scrape only because
  the insert is `ON CONFLICT (key) DO NOTHING` and the `--rescore` / `--reflag` updates name their columns
  explicitly — `test/dismiss.test.ts` pins all three.
- **`posts.links` / `phones` / `ref_ids` / `channels`** — the other ways a post can be reached. The first
  three are what the card carried; **`channels` is the judgement**, from `channelsOf()` in `scraper/lib.ts`,
  and it is what the scraper gate, the Posts badge and the `channel` filter all read. Stored rather than
  derived because extraction is unconditional while admission is not — a post kept for its email still
  records the marketing link beside it, so `json_array_length(links) > 0` is a lie in the UI. Measured:
  7 of the 27 live rows carry a link and **none** is an application link. `ref_ids` is metadata only, never
  a channel. **`links` is not `post_url`** — that is the post's own LinkedIn permalink.
- **The first address is the recipient; every other address on the post becomes the `Cc`.** `ccFrom()` in
  `server/utils/gmail.ts` decides it, and both draft paths pass it. A post that says "send to X, CC Y" is
  giving an instruction, and dropping Y is not cosmetic — it cost a real application, because the second
  address was the person screening the CVs. The **group key stays `emails[0]`**: `contacts` keeps one row
  per recruiter, so a Cc'd party never becomes a contact of their own and never earns their own email —
  the two-emails-ever ceiling counts recruiters, not addresses. Exclusion is **by value, not position**,
  because the follow-up sweep matches a contact through `json_each` at any index; the owner's own address
  is dropped too. Pinned by `test/stages.test.ts`.
- **`posts.applied_at`** — the owner applied by hand, through the post's link or number. Same shape and same
  reasoning as `dismissed_at`, written by `POST /api/posts/applied` through `setApplied()`, and deliberately
  **not** a third `applications` verdict: the follow-up sweep finds unmentioned roles by the *absence* of a
  `named in ...` reason, so a `manual` verdict row would read as a role still owed an email. It rides beside
  `dismissed_at` in all three email-deciding queries and in `usable` / `unprocessed`. It is **not** in the
  yield table's `usable`, on purpose — that column rates the search term, and an application is the owner
  saying a post *was* worth having, the opposite signal to a dismissal.
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
- **`post_requirements` / `requirement_runs`** — the gap record, for improving the CV and choosing what to
  learn. For every **application** (`applications.verdict = 'drafted'` or `posts.applied_at` set) the
  `gaps` job reads the post against the master CV with one `gpt-5-mini` call (`JOBFINDER_GAPS_MODEL`) and
  stores each requirement: `term`, `category`, `importance` must|nice, `status` present|partial|absent,
  the post's `quote` and the CV's `cv_shows`. **Both quotes are verified verbatim in code**
  (`verifyRequirements` in `server/utils/gaps.ts`: a quote of 8+ letters/digits compared by `matchKey`, a
  shorter one — `C#`, `Redis`, a third of the CV's skills — only as a whole word via `excludeRule`): a row whose
  post quote is not in the post, or whose present/partial CV quote is not in the master CV, is never
  stored, and an `absent` row carries no CV quote. `requirement_runs` records which CV (`cv_sha` =
  `pdfSha256`) each post was read against, so uploading a new CV makes every run stale and the next job
  re-reads them. Triggers: after a draft job that drafted and after Mark applied — both **keyed to just
  those posts** (`args.keys`), so a stale-CV backlog is never read behind a draft — and **Extract gaps** in
  the Run view, the only full backfill. There is deliberately **no daily run**: it re-read the whole
  history after every CV upload, for hours, unasked. A queued full run swallows any gaps request; keyed
  runs queue separately. Dedupe is against the **queue only** — a running job already chose its posts. The **Gaps** page groups each term: **Learn** when its most frequent status is `absent` (ties go
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
  **The one rule for any CV-enhancement pass**: a **present**-majority Add-now term may go onto the CV; a
  **partial**-majority Add-now term only after reading its `cv_shows` lines and confirming the evidence
  really is that skill; a **Learn** term only when the owner confirms they have it — Learn means the CV
  shows no evidence, not that the owner lacks the skill, and the checks bias toward it (an absent row can
  never fail the CV-quote check, a present/partial row can, and a tie already goes to the worse status).
  Read `importance` loosely too — it defaults to `must` whenever the post does not say, so it mostly means
  "not marked optional," not "a hard requirement." `tailoredCv()` refuses technology the master CV does not
  name, so the base CV is the only place honesty can slip — this is where it is held. A newly uploaded CV
  makes every application stale, but nothing re-reads them until **Extract gaps** is pressed — about a
  minute each on the draft lane (hours for the full history); Stop is safe, the job resumes newest-first.
  Until then the Gaps page mixes reads from both CVs.

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
- `constraints` — `remoteAnywhere`, `onsiteCountries`, `willRelocate`, `canStartImmediately`, `workingHours`
  and `expectedSalary`. (`stackWeighting` is gone — see `scope` below.) `expectedSalary` is **free text**,
  not an amount and a currency: what a post wants back may be a range and may differ by work model, and a
  number field would force a guess at exactly the value a guess must never be made about. Quoted verbatim
  when a post asks. It is deliberately **not** in `missingFields()` — most posts never ask, so an empty one
  must not block every draft; a post that does ask and finds it empty is skipped, never drafted with a
  blank. The prompt says `NOT PROVIDED` rather than omitting the line, so the model can tell "the owner
  gave me none" from "no post asked". An existing row needs no migration: `upgradeSettings()` shapes every
  read over `EMPTY_SETTINGS`, so a new key arrives with its default.
- `scope` — `roleFamily`, `primarySkills`, `secondarySkills`, `excludedRoles`, `seniorityFloor`. **Read by
  the scorer, the pre-screen and the drafter**, which is why it is separate from `background`. Every one is
  omitted from its prompt when empty rather than emitted blank.
- `background` — `evidence`, `gaps`, `strengths`, `neverClaim`. Read by the drafter only, and the content
  that used to be hand-written into the skill file. `gaps` is a list, not prose, so each entry can be
  deleted on its own — that per-item review is the defence against a generated gap nobody actually has.
- `cv` — repo-relative path under `data/cv/`, written by the upload endpoint rather than typed. The scoring
  model reads the PDF itself once per run (`input_file`); no PDF library.
- `terms` (the home feed plus 8 searches), `titles` (30, for the scoring prompt), `max`, `since`.
- `excludes` — words, names or domains that disqualify a post outright, becoming the `excluded` flag
  (see the data model above). Read by the pre-screen only: it never reaches a prompt, because a hard
  rule the owner wrote does not need the model's opinion. `min(2)` per entry, because a
  one-character needle matches every post ever scraped. `parseSettings` folds case when deduping, since
  the match does. Two ways in: the Settings list, or **Exclude…** in a post row's ⋯ menu, which posts
  to `/api/settings/excludes` rather than PUTting the whole config back from a page that never loaded
  it to edit — the same trap the CV upload documents below. Both then wait for a re-flag. **Saving
  Settings re-flags whenever `flagInputs()` in `shared/settings.ts` changes** — every field `flagRules()`
  reads, not only `excludes`; a stored flag is never recomputed otherwise, and a floor change once left 7
  posts scoring 6-8 out of the queue. `test/settings.test.ts` mutates every setting and fails if
  `flagRules()` reacts to one that list omits. **The decision is the server's** (`config.put.ts`,
  `settings/excludes.post.ts`), taken against the stored row: the page used to take it against its own
  load-time copy, so a save from a stale tab could write old flag inputs back and skip the re-flag. The
  page still requests one to report the count; `enqueue()` drops a second queued reflag.
- `contactChannels` — which contact routes admit a post, `['email' | 'link' | 'phone']`, default `['email']`
  so an existing install is unchanged. `CONTACT_CHANNELS` in `shared/settings.ts` is the one definition
  (`scraper/lib.ts` re-exports it — it imports `node:crypto` and cannot be what a browser bundle reads).
  `parseSettings` orders and dedupes it, so the order the Settings dirty check depends on is a property of
  the stored row. Empty saves but `missingFields()` refuses to run: the usual two-schema split.
- **`.env`** — `OPENAI_API_KEY`; optionally `JOBFINDER_DB`, `JOBFINDER_MODEL`, `JOBFINDER_DRAFTER_MODEL` (default `opus`), `PROFILE_DIR`, `JOBFINDER_SYNC_DIR` (the two-machine hand-off; unset = off). Loaded with
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

Evidence, gaps and strengths live in the `background` settings block, not in any file. **If the CV changes,
re-upload it and press "Generate from CV" in Settings**, then review every line before saving — otherwise
drafts keep arguing from a stale CV.

## Gotchas (each cost real time)

### LinkedIn and the scraper

- **Outbound links are opaque.** LinkedIn rewrites most to an `lnkd.in` hash — 11 of 11 in the stored
  corpora, and 11 of 12 in a live feed sample — and the exception was `okt.to`, somebody else's shortener,
  so it is no better. The hash is in the anchor `href` as well as the text. You cannot tell a careers page
  from a blog post, and
  domain filtering (`lever.co`, `/careers`) is impossible without following the redirect. Link admission
  is therefore gated on the **prose**, and on proximity, not on the URL: `applyCueNear()` in
  `scraper/lib.ts` wants an apply cue within **300 characters before** the link. Whole-text matching was
  tried first and was wrong — it admitted a BBC Writers post whose link is introduced as "you can find the
  blog post here", because the prose elsewhere says writers "need to apply separately". Measured, and the
  two cases separate cleanly: the one genuine apply link sits 163 characters after its cue, that false
  positive 779, and the other nine links have no cue before them at all. Re-measure with
  `npm run dry` before touching `APPLY_CUE` or `CUE_WINDOW`.
- **`PHONE_CUED` wants a noun for a phone; `PHONE_SENDCV` covers "send your CV to \<number\>".** Every cue in
  the first is a word naming a phone (whatsapp/mobile/tel/call/contact), so a post reading *"send your
  resume to \<number\>"* extracted nothing and was dropped for carrying no contact route at all — measured
  live on a score-7 post, and proven with a control on the same digits. The second cue needs a connector
  (`to|on|via|at|through`) immediately before the digits: without it, "share your cv, salary 15000 - 20000
  EGP" reads as a ten-digit number, because a salary range has exactly a phone number's shape.
- **A phone number needs proof.** Years, salaries and "5-7 years" are all digit runs, so `extractPhones`
  takes an international number on its leading `+` and a local one only where a contact word precedes it.
  `\b` is ASCII-only in a JS regex, so it is on the Latin cues (or `tel` fires inside `hotel`) and off the
  Arabic ones, where it would never match. **Never write a literal number in `scraper/lib.ts`** — a regex
  source is safe, a number in a comment is not: `test/identity.test.ts` scans that directory for the shape.
- **Do not add `contentType=["jobs"]` to the search URL.** It means "posts embedding a Job card" and returns
  almost nothing with no emails. Only `datePosted` is used.
- **A search term is an AND of its content words, so every word multiplies the pool by that word's frequency
  in post prose.** Stopwords are effectively dropped — a four-word term whose literal phrase appears in 11%
  of posts still returned 56 cards, so `we are X` searched as `X`. Content words are not dropped, and **one
  rare word zeroes the term outright**. Measured 2026-09-17: a four-content-word term whose rarest word
  appears in under 3% of posts returned LinkedIn's **"No results found"** page — a genuine empty result, not
  the throttle, and `logs/zero-<term>.png` is how you tell those two apart. Three of nine configured terms
  were returning zero rows this way, silently, for weeks.
  **The counter-intuitive part: the owner's own specialist vocabulary is usually the rarest word in
  postings**, so a term naming the exact stack they want returns nothing while a term naming only the role
  family fills its quota. Let the CV scorer sort for stack fit; do not ask the query to do it.
  **Keep a term to three or four common content words**, and measure before adding one that names a
  technology, a country or a two-word job title — count how many stored hiring posts contain the candidate
  word:
  ```bash
  sqlite3 <db> "select json_group_array(lower(text)) from posts
    where coalesce(post_type,'hiring') = 'hiring'" > /tmp/corpus.json
  ```
  A word under ~5% will strangle whatever term it is added to. **The count is only unbiased for a word no
  existing term searched for** — the corpus was gathered by the current terms, so a query word's own
  frequency is inflated and proves nothing.
- **Precision matters as much as recall, because `max` is per term.** Measured across one nine-term run, the
  best term returned 12 usable posts from 50 cards while the broadest returned 2 from 56 — same volume, a
  sixth of the yield. A broad term that fills its quota with junk spends the card budget and the OpenAI bill
  a sharper term would have used, since admission runs before scoring. Naming the seniority floor in the term
  itself was the cheapest precision lever measured. The per-term yield table is the evidence:
  `select search_term, count(*), sum(score >= 6 and coalesce(post_type, 'hiring') = 'hiring'
  and json_array_length(flags) = 0) from posts group by 1`.
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
- **The "…more" expander follows the UI language, not the post's.** Those first ~10 cards carry
  `…المزيد` even on an English post, and the click loop matched `…more` only: measured 2026-09-26, 7 of
  the first 9 feed cards were stored **collapsed**, two of them hiring posts that kept their address only
  because it sat above the fold. `MORE_LABEL` in `scraper/lib.ts` carries both labels and
  `test/lib.test.ts` pins it. Fixing it exposed the next limit: the stored card was cut at 3000 characters,
  which is LinkedIn's cap on the post *body* alone — the header adds up to 1605 more — so a full-length
  post lost its tail, where the address sits (median at 86% of a post). `TEXT_CAP` is 6000.
- **`npm run dry` prints a quality line per term** — cards over `TEXT_CAP`, cards still collapsed, no
  author, no age, no channel, duplicate keys — and `len=` per card. Read it after any change to
  `readCards` or the expander. Measured 2026-09-26: a search term 40/40 cards, 40/40 permalinks, all clean;
  the feed's undated cards are sponsored posts and the composer box, which carry no age and no channel.
- **The feed's reposts name the wrong author** unless you look: a card opening with "X reposted this" links X
  first. `readCards` picks the **most repeated** href — the real author is linked three times (avatar, name,
  menu), a resharer twice.
- **The drifting-header dedupe bug:** the first key included "21h", so the same post came back as "22h".
  Anything added to the key must be stable across runs. Covered by tests.
- **The header used to eat the whole key window, and that lost posts.** Until 2026-09-18 the key hashed
  the first 160 characters of the *whole* card, header included. Measured over the 655 stored posts
  carrying a Follow marker: the header alone fills p50=87, p90=195, max=1605 of those characters, and
  **119 leave zero body characters in the key** — so an author with a long headline hashed every post
  they wrote to one key and all but the first were dropped as duplicates they never were. Found live on
  the feed: two different posts, different ages, different links, one key. `keyText()` now starts at the
  Follow marker (`متابعة` too — `\b` is ASCII-only, so it is on the Latin spelling and off the Arabic).
  **Changing the key re-keys every stored row**, which is why `legacyKey()` exists: `storedKey()` checks
  the old hash too, so a re-scrape recognises a row instead of storing a second copy. Do not delete it
  as dead code — `applications.key` references `posts.key` ON UPDATE NO ACTION, so the alternative was
  FK surgery, and the `feed` term has no date filter, so an old-key row can resurface indefinitely.
  Verify a change here the way this one was: `npm run dry -- --terms feed --max 50` and count duplicate
  keys in the output (1 before, 0 after).
- **Rate-limit posture:** 9 terms, 40 cards, randomized pauses, headed Chrome, `--enable-automation` off. A
  LinkedIn checkpoint page is treated as a lost login (**exit 2**, `login expired`). Fix with `npm run login`.
  Avoid many manual scrapes in one day.
- **A throttled search looks exactly like an empty one, and used to be silent.** After enough scraping
  LinkedIn serves `/search/results/content/` as a normal 200 reading *"Our systems have detected unusual
  search traffic coming from your account"* and returns nothing. The URL never changes, so the
  `login|authwall|checkpoint` guard cannot see it. Measured 2026-09-17: six configured terms each logged
  `0 cards` in one afternoon after returning 15-20 posts each that morning — and the run walked on to the
  next term every time, asking a throttled account for more. `isThrottled()` in `scraper/lib.ts` now reads
  the page text and aborts the whole run with **exit 3**; the Run view says to leave it until tomorrow. It
  clears on its own — there is nothing to fix and scraping again only extends it.
  **The match is on the English wording**, and LinkedIn serves this account Arabic often enough that a
  paused search can still arrive as a plain zero. That is why a zero-card term now logs the path of the
  screenshot it already saved: `logs/zero-<term>.png` is the evidence, and nobody was looking at it.
- **The scroll loop's patience is wall clock** (`SCROLL_STALL_MS`, `keepScrolling()`), not a count of
  iterations. Counting rounds was time-blind: four rounds of a 2-5s sleep is as little as **eight seconds**,
  and LinkedIn's lazy-load routinely takes longer. Measured: one feed run stopped at 28 cards and reported
  that as the whole feed, while the next minutes later found 58. The longer wait is paid only by a term
  that genuinely has fewer posts than `max`; a term that fills its quota exits immediately (verified: 10
  cards in 10s).
- **A term that resolves half its permalinks looks identical to one that resolves all of them**, so the
  per-term log prints both counts. Measured over a full 13-term run (75 cards a term): **769/866 = 88.8%**,
  per term between 63% and 96% — not the 26/26 this file used to claim, and not the 29/50 measured before
  the scroll fix, which was low because less scrolling means fewer pagination payloads.
  **The cause is responses whose body cannot be read**, and nothing else. `await res.text()` throws for
  ~14 responses a term, and the correlation between that count and the cards left unresolved is
  **r = 0.921 over 12 terms**, at 0.54 cards per lost body. Everything downstream is provably clean:
  `urnMap` paired **339 of 339** tokens present in the captured payloads, `droppedByDuplicateGuard` was
  **0 on every term**, and `tokenFoundInMap` equalled `resolved` every time. So the search-path pairing
  rule is sound and is not the thing to change. Closing the last ~11% means logging the URL and status of
  the responses that lose their body, to learn whether they are redirects (which carry no URN anyway) or
  real payloads — deliberately not done, because a permalink is secondary to the address that makes a post
  actionable.
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
  recruiter would later have been told about a role the first email already covered. The **Gmail-gate**
  skip insert in `jobs.ts` carries `WHERE applications.verdict <> 'drafted'`; `persist()` in `drafts.ts`,
  which writes the model's own verdicts, does **not**. The batch queue can never reach it with an existing
  row (`a.key IS NULL`), and the single-key path no longer writes a skip at all (below), so the gap is not
  currently reachable — but it is a gap, not a decision.
- **Pressing Draft on one post is the owner overruling the fit screen, and it never writes a `skipped`
  row.** `const manual = !!args.keys?.length` in `runDraftJob` is the whole discriminator: `pump()` only
  coalesces single-post requests with each other, so a `{ n }` job can never arrive carrying keys.
  **Bulk Draft is the exception:** the Posts view's bulk bar sends `{ keys }`, which `draft.post.ts` always
  enqueues with `screened: true`, and the discriminator is `!!args.keys?.length && !args.screened`. A
  screened run is triaged like the batch run — skips are recorded — and `keyedDraftRows()`
  (`server/utils/draft-rows.ts`) gives it only posts with no `applications` row, because `persist()` would
  otherwise rewrite a `drafted` verdict as `skipped`. Pinned by `test/draft-rows.test.ts`. In hand-picked
  mode the Gmail gate and `persist()` both refuse to record a skip — they write nothing, which leaves
  whatever was already there. **Two different outcomes, and the distinction matters when reading a row:**
  a post with no prior row stays unprocessed and the next bulk run re-triages it; a post carrying an
  earlier *bulk* `skipped` row keeps that row and its reason, stays out of the batch queue, and keeps its
  Draft button to be pressed again. So the log's `passed over (no verdict recorded)` is about **this run**
  — the button's tooltip may still show the older bulk reason. **In code, not in the prompt** — the procedure's `chosen: true` block
  softens the *fit* hard skips (location, residency, seniority, hours, gaps, field of work) into soft
  flags, but the model still returns `skipped` sometimes, and a persisted skip on a hand-picked post is
  no email and no way back. `test/manual-draft.test.ts` pins both directions, including the control that
  a **bulk** skip is still recorded — without it the guard could quietly empty the triage queue.
  **Since 2026-09-21 no skip survives a chosen post, by the owner's decision**: the procedure makes all
  eight hard skips soft flags — not hiring and no content included — and a required value that was not
  injected is left unanswered in the email and named first in the report, never a placeholder.
  `checkContract` rejects a `skipped` verdict when `req.chosen`, so a refusal fails the job with the
  model's reason and "press Draft again" rather than logging `passed over`; the `persist()` guard above
  is now defence in depth. The cost that used to justify keeping *not hiring* hard: on the 2026-09-17
  backup it caught a staffing agency's sales pitch the scorer had scored 6, so a mistaken press now
  yields a draft to that person — a draft, reviewed before anything is sent. `test/drafter.test.ts` pins
  the rejection and its bulk control. The Gmail gate is unchanged: a recruiter already written to is
  still refused, because that is the two-emails ceiling, not a fit judgement.
- **An email with a hole in it must never be deliverable.** A draft went out reading
  `Expected monthly salary: [ADD BEFORE SENDING]` and the recruiter replied to point at the gap. Nothing
  downstream reads the body before Gmail does, so `PLACEHOLDER` in `server/utils/drafter.ts` rejects a
  square-bracketed slot or a `TBD`/`TODO` in the subject or body, inside `checkContract`. **In code, not in
  the prompt**, for the same reason `gateOnPostType()` is: the model follows a written instruction most of
  the time, and "most of the time" is the failure. Both directions are pinned by `test/drafter.test.ts` — a
  clean email must still pass, or the guard would quietly empty the queue.
  **A rejection and a skip are not the same outcome, and the difference is which queue the post falls back
  into.** The procedure tells the model to skip a post whose required value was not injected, which is the
  intended path and writes a `skipped` row — and the batch queue is `WHERE a.key IS NULL`, so that post
  never returns to it; after filling the missing setting it is re-drafted per post from the Posts view,
  whose single-key query carries no such filter. **That recovery path was prose only until 2026-09-17**:
  the Draft button was hidden whenever the row had a verdict, and `'skipped'` is as truthy as `'drafted'`,
  so a skipped post had no control that could reach the single-key path — it was reachable by `curl` and
  nothing else. It gates on `r.verdict === 'drafted'` now, and carries the skip reason as its `title`.
  Pinned by `test/manual-draft.test.ts`, because the bug was invisible: nothing failed, posts just quietly
  stopped existing. **The re-draft still depends on the recruiter**: if an
  application to them has already gone out, the Gmail gate closes at row 5 and pressing Draft declines the
  post again rather than sending a second application. It writes no `applications` row, but the gate's
  `healContact()` does write the stage into `contacts`, and the Posts view reads that: `posts.get.ts`
  joins `contacts` on `emails[0]`, the Status badge shows the recruiter's stage over the verdict, and
  `sentTo()` in `shared/recruiter-stage.ts` hides Draft on every stage but `drafted` — a pending draft
  deleted unsent reopens the recruiter, and only the gate can see that. Unprocessed, and the To review KPI
  with it, drop a post whose recruiter has **any** stage (`neverWrittenTo()` in `server/utils/contacts.ts`,
  NOT EXISTS because NOT IN over a no-address post's NULL would drop every link-only post); the bulk queue
  does not, so a stale `drafted` recruiter is still re-asked of Gmail there. It is not
  lost either way — a skipped reason does not start
  with `named in `, so the follow-up picks the role up and names it there. A guard rejection writes no row at all, so those posts stay
  unprocessed and the next run picks them up, the same posture as a failed score. `jobs.ts` catches per
  recruiter, so either way one recruiter fails and the other eight still get their emails.

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

- **A server edit drops every running and queued job.** Nitro 2.13's dev server runs the app in a
  `worker_thread` and replaces it on every server rebuild (`nitropack/dist/core/index.mjs`: `new Worker`,
  then `terminate()` on the old one). `globalThis` is per thread, so `__jobfinderRunner` does **not** survive
  that — measured 2026-10-01: one edit to `server/api/posts.get.ts` lost a running draft and 18 queued ones.
  The `globalThis` placement still matters for module-level HMR inside one worker (the scraper once kept
  writing rows while the UI showed an idle lane), so any long-lived server state needs it — but it is no
  protection against a rebuild. **Since 2026-10-03 the queue survives it** (`job_queue`, below): a
  rebuild still kills the running job, but `restoreQueue()` puts it back at the front of its lane —
  except a scrape-lane job, which is dropped. So **still check `curl -s http://127.0.0.1:3939/api/job`
  before editing anything under `server/`** (or a `shared/` / `scraper/` file the server imports): an
  interrupted draft re-runs from the start of its recruiter list, and an interrupted scrape is lost.
  **A new file under `server/plugins/` is not loaded by a running dev server** until a full restart —
  measured: a new plugin never ran across a rebuild — so boot-time work goes into an existing plugin.
- **Two machines hand off, never share.** The owner alternates a Windows PC and a Mac, never running both.
  `server/utils/handoff.ts` pulls a newer `VACUUM INTO` snapshot from `JOBFINDER_SYNC_DIR` at boot —
  inside `db.ts`'s `open()`, before any connection exists — and `server/plugins/handoff.ts` pushes one
  every 2 minutes when `changeSig()` moved. **That signature is `data_version` plus `total_changes()`,
  and both halves are load-bearing**: `total_changes()` counts the server connection only, while the job
  runners write through their own `openWritableDb()` connections, which only `data_version` sees. `gen`
  in `sync.json` makes each push a compare-and-swap, so a machine that booted before OneDrive delivered
  the newer snapshot is refused (banner + `backups/conflict-*.db`) instead of overwriting it; any other
  `jobfinder*` / `sync*` file in the folder is a sync-client conflict copy and stops both pull and push.
  **`sync.json` carries the snapshot's sha256 and a pull refuses a mismatch**: OneDrive delivers the 1 KB
  `sync.json` before the 8 MB snapshot, and pulling the previous generation's data under the new gen
  would let the next push erase the other machine's session. **Nothing pushes on its own without a
  change since boot** (`lastSig` starts at the current `changeSig()`), and **an empty folder is seeded
  only by an explicit init** from the Run view — an empty folder and an undelivered one look identical.
  Heartbeats go to per-host `heartbeat-<host>.json` files, never `sync.json`, so they cannot collide
  with a push. **Never move `data/`
  itself into OneDrive** — a file sync of a WAL database is the 2026-09-25 backup bug. **Paths written to
  the database use `/`** (`tailoredCvPath` is `posix.join`; `migrate.ts` rewrites old rows each boot),
  because `\` is a filename character on the Mac. `scripts/merge-db.ts` is the one-time, insert-only merge
  of a machine's pre-sync history. Setup: SETUP.md, "Two machines". Spec:
  `docs/superpowers/specs/2026-10-03-cross-machine-sync-design.md`.
- **Port 3939 is pinned** in `nuxt.config.ts`. Port 3000 is taken on this machine, and Nuxt silently drifting
  to 3001 would invalidate the Gmail OAuth redirect URI.
- **The server is the sole writer of the database.** The scraper opens it read-only and streams rows back.
  Keep it that way: two writers is how you get `SQLITE_BUSY` under a long scrape.
- **`UDashboardPanel`'s `#body` is a flex column** — cards need `class="shrink-0"` or they get clipped
  instead of scrolling.
- **The Claude-in-Chrome extension cannot open localhost.** Verify the UI with `node scripts/screenshot.mjs`,
  which drives headless Chrome through `playwright-core`.
- **Four job lanes and a durable queue** in `server/utils/jobs.ts`: `scrape` (one at a time, Chrome profile
  lock), `draft` (draft + Gmail `sync`), `paste` and `gaps` all run concurrently; everything else queues,
  so `POST /api/run/*` returns 202 and never 409. **`gaps` has its own lane** because it is OpenAI, not
  `claude`, and an hours-long backfill used to hold every Draft press and the sync behind it; **`sync`
  stays on the draft lane** because beside drafting it could write an application and a follow-up to the
  same recruiter at once. **The draft lane is priority-ordered** (`pickNext()` in
  `server/utils/queue-core.ts`): hand-picked drafts (`key`, or `keys` without `screened`), then `sync`,
  then bulk/batch, FIFO within each. Single-post draft requests waiting in the queue are batched into
  one session. **Within a draft job, recruiters run `JOBFINDER_DRAFT_CONCURRENCY` at a time** (default 2,
  clamped 1-4, `pool()`), and **`runDrafter` is retried once after 10 s** (`withRetry()`) — never
  `createDraft`, where a retry could leave two Gmail drafts. **The queue is mirrored into `job_queue`**
  (`saved.add/start/drop`) and `restoreQueue()`, called from `server/plugins/migrate.ts`, puts it back
  in a fresh worker: interrupted non-scrape jobs at the front, interrupted scrape-lane jobs dropped (a
  re-run scrape on every edit would spend the LinkedIn rate limit). The table rides in the cross-machine
  snapshot, so queued work moves to the other machine. `queue-core.ts` holds every queue decision as a
  pure function, because no test can import `jobs.ts`. Stop sends SIGTERM; Playwright's own handler only
  closes Chrome, so the scraper keeps a `stopping` flag and throws at the next loop check (exit 1).
  `pump()` iterates `Object.keys(lanes)`, but the `Lane` union (now in `queue-core.ts`), the `Kind`
  union, the state initialiser, `laneOf()`, `busy()`, `runJob`'s dispatch branches and `stateView()` all
  name every lane explicitly — plus `Lane` in `app/types/index.d.ts`, the `lanes` seeds in `run.vue` and
  `pipeline.vue`, and the Stop endpoint's lane enum. **`state.lanes.paste ??=` / `gaps ??=` right after the
  initialiser are load-bearing**: `__jobfinderRunner` lives on `globalThis` to survive module HMR inside
  a worker, so a state object from before a lane existed is missing that key, and `??=` on the whole
  object will not add a key to an object that is already there.
- **`shared/paste-poll.ts`** matches the paste card's poll response to the local entry it belongs to, kept
  out of `app/pages/index.vue` and Vue entirely so `test/paste-poll.test.ts` can exercise it under
  `node --test` (there is no Vue test setup here). The paste lane's `/api/job` view exposes only the one
  most recently finished job, never a history, and carries no per-job id — so matching "the oldest queued
  entry" by position was tried first and was wrong on two ordinary flows: pasting a second post before the
  first resolves, and pressing "Paste again" after a refusal, which resubmits the identical text as a new
  local entry. `findFinishedMatch()` instead matches on the pasted text (the server's own dedupe key for an
  in-flight paste) plus the finished job's `endedAt` landing after the local entry's own timestamp, which is
  what tells a genuine completion from a stale one apart.

### Environment

- **Also runs on Windows 11.** What differs:
  - **Node is pinned by Volta** (`"volta"` in `package.json`, 22.23.2). Type stripping is default-on only from
    22.18; an older Node makes `npm test`, the scraper and the server's scraper spawn die with a SyntaxError on
    the first type annotation. Install dependencies under the pinned Node: `better-sqlite3` is native.
  - **`npm run db:migrate` fails on a fresh clone** (`data/` does not exist and drizzle-kit does not create it).
    Skip it: `npm run dev` creates `data/` and migrates at boot.
  - **Paths built with `join()` use backslashes** — compare against `join(...)`, never a `/` literal
    (`test/invariants.test.ts` failed on exactly that).
  - **Stop is a hard kill.** `child.kill('SIGTERM')` is `TerminateProcess` on Windows, so the scraper's
    `stopping` flag never runs and Chrome can outlive it, holding the `./profile` lock until closed by hand.
- **`--setting-sources local` is what keeps the user-global `~/.claude/CLAUDE.md`, hooks and plugins out of
  the drafter.** `neutralCwd()` only avoids the *project* CLAUDE.md, and `--strict-mcp-config` only skips MCP.
  Before the flag, a one-post draft took ~175s and the model quoted a job title and three plugins' hook
  instructions from the global setup; with it, a probe came back clean 2 of 2 and a real one-post draft took
  21s. `--bare` would also skip them but accepts only `ANTHROPIC_API_KEY`, never OAuth. Dropping user
  settings drops their `model` too, so `--model` is explicit (`JOBFINDER_DRAFTER_MODEL`, default `opus`).
  Pinned by `test/invariants.test.ts`, including that the flag sits before the variadic tool flags.
  `local` drops the whole user settings file, **including its `env` block** — certificates, auth and API
  routing live there (`NODE_EXTRA_CA_CERTS` on this machine) — so `userSettingsEnv()` passes that block to
  the drafter process on its own; the process's environment wins a clash.
- **The drafter's system prompt goes in a file** (`--append-system-prompt-file`, one per run, removed when
  the run ends — it holds the whole profile). On the command line Windows capped it at 32,767 characters;
  the 28,000 `PROMPT_BUDGET` that stood in for that cap was exceeded by 165 on 2026-09-26, and `jobs.ts`
  answers a failed budget by dropping the master CV, so **CV tailoring silently switched off** with one log
  line. The budget is a sanity bound now (100,000). A probe that hands `runDrafter` a master CV directly
  skips that gate — verify tailoring through `fitsPromptBudget`, the way `runDraftJob` does.

- **`npm run typecheck`'s coverage boundary is reachability from a typechecked entry point, not a
  directory — and it moves silently as imports are added.** `scraper/run.ts` is still uncovered, verified
  by injecting `let x: string = Date.now()` into it: exit 0. That is also why `c.postUrl` type-checks
  against a `Card[]` that has no such field — nothing under `server/` imports `run.ts`, so nothing pulls it
  into the Nuxt/tsc graph. But `server/utils/paste.ts` was the first file under `server/` to import
  `scraper/lib.ts` (which pulls in `scraper/score.ts` via a type import too), and that one new import edge
  surfaced a real pre-existing bug the moment it landed: `scraper/lib.ts` re-exported a `Constraints` type
  it never imported, invisible for as long as nothing typechecked reached it, and `nuxt typecheck` failed
  immediately with `TS2304: Cannot find name 'Constraints'` once it did. So a change confined to `run.ts`
  is only as verified as the `scraper/lib.ts` unit tests plus an actual `npm run dry` — run one — while a
  change to `lib.ts` or `score.ts` now gets a real typecheck, on the strength of one import in `paste.ts`.
- **The stored corpus cannot measure an admission rule.** `posts` holds 0 rows with no email out of 676,
  because the gate has always required one — so "run the rule over the stored posts first" (right for
  excludes and `seeking-work`) is circular for anything deciding what gets *admitted*: the misses were
  filtered out before they could be stored. A phone-cue miss measured 0/676 in the database and 1-in-50 on
  a live dry run. Only `npm run dry` samples the population an admission rule acts on.
- **PostgreSQL is not installed and Docker owns port 5432** (`onebench-postgres`, another project). That is
  why this branch moved to SQLite rather than following the original `SETUP.md`.
- **npm, not pnpm.** The Nuxt UI dashboard template ships `packageManager: pnpm@12.3.4`, `pnpm-lock.yaml` and
  `pnpm-workspace.yaml`; all three were removed. A standalone pnpm 10 exists on this machine, but the pinned
  v12 is what breaks corepack.
- **`@unovis` was dropped** from the template: it pulls `maplibre-gl` with a critical XSS advisory whose fix
  needs a major bump `@unovis` cannot take, and nothing here renders a map or a chart.
- **The CV PDF is ~56 KB** (measured 2026-09-17: two pages, no images, set in Carlito). Earlier notes said
  ~1.4 MB; that was an older file.

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
- **A tailored CV, when `tailorCv` is on** (off by default). The PDF is extracted once into a master CV,
  cached in `data/cv/master.json` against its sha256 **and `MASTER_CACHE_VERSION`**, and every bullet must
  appear in a verbatim extraction of the same PDF or nothing is cached. **Bump that version whenever
  `MasterCv` gains or loses a field**: the PDF's bytes do not change when the shape does, `masterCvBlock`
  does not read the newer fields so the prompt looks fine, and `masterText` spreads them — so a cache
  written under the old shape is served forever and every draft falls back with
  `m.achievements is not iterable`. A missing or mismatched version is a miss, costing two model calls
  once. `assignIds` also strips control and format characters from every
  extracted string, keeping tab, newline and carriage return: a PDF's text layer carries characters the eye
  never sees — a stable `\x0E` turned up in the real CV's summary on every extraction — and `matchKey`
  strips them before comparing while `missingBullets` only covers bullet text, so nothing else would have
  caught one before it printed into a CV. Education, certifications, achievements, personal details,
  languages and interests are never tailored: copied from the master verbatim and never shown to the model
  (`masterCvBlock` lists only the summary, roles and skills). Education, certifications and languages were
  in the schema from the start; achievements, personal details and interests joined it only after separate
  preview runs against the real uploaded CV showed each was being silently dropped — the schema had no
  field for it at all, not just an empty one. The drafter returns a `cv` block
  beside the email, kept `z.unknown()` so it can never fail the email, and `tailoredCv()` in
  `server/utils/cv-tailor.ts` checks it: the same roles in date order, each bullet once under its own role,
  skills renamed never, no new number, no technology-shaped token the master CV does not name, nothing
  longer than 1.5× its source plus 20 characters, no placeholder. **A bullet's numbers come from that
  bullet; the summary's come from the master summary and the role dates only** — the whole-CV pool
  included a date of birth and a graduation year, so any of those digits could be re-used as a
  years-of-experience claim. Rule 5 is weaker than it sounds and the prose used to overstate it:
  `isTech` recognises a technology **by shape** — a token carrying a digit, `.`, `#` or `+` (`C#`,
  `.NET`, `ES6`), or one written in bare capitals (`AWS`). An ordinary capitalised name (`Kafka`,
  `Kubernetes`, `Terraform`) is not caught at all, and the all-caps branch is defeated by any punctuation
  `tokens()` does not split on, so bare `AWS` is rejected while `"AWS"`, `*SAP*` and `AWS-native` pass.
  It is a net for the obvious cases, not a guarantee, and `test/cv.test.ts` pins that ceiling as a
  **passing** test so tightening it is a visible change. **Rule 8: the CV never declares a gap** —
  "no direct experience", "familiar with", "currently learning" and the like are refused unless the master
  CV itself says them; gaps are the email's to declare, once. Measured 2026-09-26: 0 of 97 real tailored
  CVs would fail it, so it pins a habit. The `HEDGE` list is narrow on purpose — no bare "learning" or
  "gap" — because a false match costs the tailoring. **The headline under the name is tailored too**
  (`checkHeadline`): it must start with `profile.title` exactly — it may describe the owner, never rename
  them — and every later word must already be in the master CV, with no number, hedge or placeholder. A
  bad headline is dropped on its own and the plain title prints; the CV keeps its tailoring. The job log's
  `cv: tailored` line names the headline used or why it was dropped. **Any failure attaches the uploaded PDF** —
  extraction, the prompt budget, the check, or rendering — and says why in the job log, with a
  `cv: N tailored, M fell back` line per job. `contacts.cv_path` records a tailored CV sent (null for the
  uploaded one); the follow-up reuses it. Tailored PDFs live in
  `data/cv/tailored/<slug>-<8 hex of the address>/` under the uploaded file's own name, because
  `createDraft` names the attachment after the file. The hash half is not decoration: `slug()` collapses
  every non-alphanumeric run to `_`, so `first.last@`, `first-last@` and `first_last@` at one agency are
  one folder, and the second render would overwrite the file `contacts.cv_path` recorded for the first —
  whose follow-up then attaches a CV tailored for somebody else's job. Rendering uses a
  fresh headless Chrome, never `./profile`. Tune the template with
  `node --env-file-if-exists=.env scripts/preview-cv.ts`, which renders the master CV through it unchanged
  so the result can be compared with the uploaded PDF after any CSS change — the first run against a new
  CV costs two OpenAI calls, and later ones reuse `data/cv/master.json`. Design:
  `docs/superpowers/specs/2026-09-17-tailored-cv-design.md`.
- **`renderHtml` emits real anchors.** Gmail rewrites bare URLs in a plain-text body into `google.com/url?q=`
  redirects; two applications went out that way on the original.
- **The follow-up is a reply, in the application's own thread.** Gmail adds a draft to a thread only when
  all three of its criteria hold — `threadId` on the request, RFC 2822 `In-Reply-To`/`References`, **and a
  Subject header that matches** — so the subject is taken from the application verbatim and whatever the
  model returned is discarded. `replyHeaders()` in `server/utils/gmail.ts` is the one place that decides it,
  fed by `Decision.replyTo` (row 6 of the stage machine, the application message itself). The procedure has
  always said "return no `subject`", and the model returns one anyway: three follow-ups went out on 17 Sep as
  fresh threads, one titled **"Follow up"**. In code, not in the prompt — the `gateOnPostType()` rule again.
  A missing `Message-ID` **fails open**: the real subject on a new thread, never a bare "Follow up".
  `createDraft` returns the thread it actually landed in and the sweep logs `NEW THREAD` when it differs,
  the same verify-don't-assume posture as the attached byte count. Measured 2026-09-17: a verbatim subject
  threads. A `Re: ` prefix was **not** tested — Gmail very likely normalises it, but verbatim is the only
  form the documented rule guarantees, so that is what ships.
- **The stage machine is a pure function** in `server/utils/stages.ts` — the original's 8-row table in code,
  with a test per row. Order matters: a bounce or an auto-reply must never be read as a human reply, or a
  live application stops dead. Silence is 72 hours from the last outgoing message.
- **Row 6 is cached as `contacted`, not `followed_up`** (`cachedStage()`, used by the sweep and by
  `healContact()`). A due follow-up is not a written one: `persist()` promotes the recruiter only once a draft
  exists. Measured 2026-09-25: pre-writing the stage left 76 of 79 `followed_up` recruiters with no follow-up
  at all. The cached note is `follow-up due <iso>`, so the Pipeline reads "follow-up due now".
- **Every recruiter who stays silent gets the follow-up, one post or many.** `followUpPosts()` in
  `server/utils/contacts.ts` sends the roles the application named (`already_named`, with
  `original_sent_at`) plus any newer post no email has mentioned. It used to send only the second half and
  hand off when that was empty — 66 of 79 due follow-ups on 2026-09-25, since the application had already
  named a one-post recruiter's only role. `checkContract` refuses a skip on an already-named role, and a
  follow-up that has one but no body; `persist()` never overwrites the application's own
  `named in application` rows (their reason and draft id). A named role counts only when named in an
  application **to this address** — a Cc-only match belongs to somebody else's application. And only the
  application that was **sent**: `named in application` rows are written when the DRAFT is created, so a
  deleted draft leaves them behind, and a follow-up built on them claims an application never made. Rows
  written together share a `gmail_draft_id`; the one that went out is the latest drafted at or before the
  row-6 message. `excluded` posts stay out too — the exclude list is a promise the batch queue keeps.
  **Row 9**: cached `followed_up`, one email sent and nothing pending means a follow-up was drafted and
  deleted unsent — it is left alone, where row 6 used to draft it again on every sweep. A follow-up that is
  not written says why in `contacts.note`, which the Pipeline shows. Stop reaches a running sync.
  Two consequences are pinned — the first in `test/stages.test.ts`, the second in `test/heal.test.ts`: **row 4 keys on the pending draft alone**, so a
  follow-up the owner drafts by hand beside a cached `contacted` is never doubled; and `isClosed()` treats
  `contacted` as closed, so the no-Gmail cache cannot open the door to a second application.
- **Gmail is the truth about what was sent; `contacts` only caches the stage.** A draft is not a contact
  until you send it. Run a sweep after sending.
- **The draft gate asks Gmail, not that cache.** Before a recruiter is drafted, `closedInGmail()` in
  `server/utils/sync.ts` runs `decideStage()` over their real mail and `closedBy()` in `stages.ts` opens the
  door on **row 8 alone** — the one row meaning nothing has ever been written to that address. This covers
  the two ways the cache misleads: a recruiter who replied still reads `contacted` until a sweep, and a
  recruiter written to outside this app has **no row at all**, which the sweep structurally cannot fix
  because it only iterates addresses `contacts` already knows. Measured 2026-09-17 over the live rows: a
  `contacted` address the cache would have sent a second application to is row 5 in Gmail, and a `drafted`
  one had actually been sent. So **a second application is never drafted** — a new role from a recruiter
  already written to rides in the follow-up, which the procedure already provides for. `closedBy` returns
  `note` and never `postsReason`: row 6's `postsReason` is `named in follow-up`, and writing that prefix
  onto a *skipped* row would tell the follow-up query its own posts were already covered.
  With no token there is no truth to ask, so `isClosed()` (the cache) is the gate — closed on every stage but a missing row — and the local-file
  draft path still works. A Gmail error writes no row and leaves the posts for the next run, the same
  posture as a drafter rejection — a `skipped` verdict is permanent as far as the batch queue is concerned.
- **`drafts` are not returned by `messages.list`, even with `in:draft`** — pending drafts are found with the
  `drafts` endpoint. Trusting the search once nearly produced a duplicate.
- **The connected account is discovered, not hardcoded.** The sweep matches sent mail by sender, so the wrong
  account would make every sent application look unsent. Settings shows a warning when the connected address
  differs from the stored settings.
- **Daily housekeeping** is a Nitro scheduled task (`server/tasks/daily.ts`, `7 8 * * *`) replacing the
  launchd plist: a dated `VACUUM INTO` snapshot in `backups/` (newest 14 — never a file copy: commits sit in
  `-wal` until a checkpoint, and the old copy lost 12 posts on 2026-09-25; `test/backup.test.ts`) and a queued sweep, so follow-ups fire without
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

- **Measured live, 2026-09-14**, over 120 cards from three job searches (`frontend developer remote apply`,
  `we are hiring frontend developer`, `frontend developer send cv`): **29 link, 28 email, 2 email+phone,
  61 no channel.** So the `link` channel roughly **doubles** what a scrape keeps, and every cue that fired
  was an "Apply now/here" or "Application link". No post carried a phone alone — the two phones sat beside
  an address — and no requisition id appeared at all, so `phone` and `ref_ids` are so far unearned weight.
  Both channels still ship **off**; the numbers say turn `link` on.
- **The link gate's recall is the open question.** 59 of those 120 cards carried a link and 29 passed; of
  the 28 rejected, 7 (four companies, evidently one template) do say "WE ARE HIRING". They may be genuine
  misses — a cue outside the 300-character window, or wording `APPLY_CUE` does not know — or the link may
  be a company page rather than an application route. The dry snippet was 60 characters when this was
  measured, too short to tell; it is 200 now, so **re-run `npm run dry` and read those rows before widening
  `APPLY_CUE`**. Widening it is cheap to get wrong in the other direction: a looser cue readmits the vendor
  CTAs the gate exists to reject.
- **Widening admission widens the OpenAI bill.** Admission runs before `scorePost`, so every newly admitted
  post is a scoring call and `max` now caps a broader population.
- **The Google round trip is exercised end to end.** Measured 2026-09-17: 25 `applications` rows carry a
  `gmail_draft_id`, `contacts` holds 20 recruiters across every stage from `drafted` to `replied`, so
  refresh, draft creation with the CV attached, sending and the sweep have all run against the real
  account. What that run also proved is the cost of an unreviewed draft: one went out with an unfilled
  placeholder where a salary belonged, and one went to a single address on a post that named a Cc. Both
  are now guarded above.
- The **Usable** KPI counts `score >= 6 AND post_type is hiring AND no flags AND not dismissed AND
  (in_scope OR remote) AND not applied`, so a
  strong role whose post never states a location is missing from the headline number. It still appears in the
  Posts list, and the **drafter queue deliberately omits the `(in_scope OR remote)` half** — the scorer leaves
  `location` unknown often enough that adding it would have excluded the one post that was legitimately
  drafted. The queue is otherwise the same predicate. So Usable can read 0 while the queue is non-empty.
- **The scoring model classifies reliably but does not reliably act on its own classification.** Across five
  rescores of the same 21 posts the `post_type` call never moved; the "then score 0" instruction was obeyed
  only sometimes. `gateOnPostType()` in `scraper/lib.ts` therefore zeroes `score`/`is_remote`/`is_in_scope`
  in code, the same way `emails` is regex and never the model's. Do not move that back into the prompt.
- **`resolveUrls` only dedupes within one search term**, and nothing constrains `post_url` to be unique, so a
  post mispaired under one term and paired correctly under another would keep both rows' URLs. Not observed —
  the search-path rule resolved 26/26 cards uniquely across the runs that established it.
- **Posts scraped from the home feed carry no permalink**, and neither do rows stored before `post_url`
  existed until a search re-encounters them (the scraper emits `op:'posturl'` for a post it already knows,
  which is the only backfill path — a re-scrape skips known posts before scoring, so the insert's own
  `ON CONFLICT` backfill never fires during a normal run).
- **An exclude rule matches prose, never a link's destination.** `micro1.ai` works because the post
  spells out `jobs.micro1.ai`; the anchor itself is an opaque `lnkd.in` hash, as the outbound-link gotcha
  above explains. A post that links to an excluded company without naming it is not caught.
- **A short needle is still the owner's own foot.** `ai` matches 9 of 42 posts even with word boundaries.
  `min(2)` only blocks the pathological single character; **Flags: Excluded** in the Posts view is the
  audit that catches a rule which is too broad, and `npm run dry` marks what a rule would catch before
  it is saved. Note that view respects the deliberately unconditional `dismissed_at IS NULL` clause in
  `posts.get.ts`, so a post that is both dismissed and excluded appears only under Status: Dismissed —
  which is why the count reported after a save comes from the re-flag job, not from that query.
- **Two open tabs can clobber an exclude.** Settings open in one tab, a row action adding a rule in
  another, then Save in the first writes the stale list back. Same class as the CV-upload bug.
- **No repair path for a draft created with a wrong CV path.** The CV is attached at creation and the byte
  count verified, so the fix is to delete the Gmail draft and re-run rather than retrofit it.

## Never commit

`profile/` (a live LinkedIn session), `.env`, `data/` (the database, the CV and drafts), `config.json`
(retired, see below), `google-oauth.json`, `gmail-token.json`, `backups/`, `logs/`, `jobs.csv`. `.gitignore`
covers all of them — verify with `git check-ignore <path>` rather than by eye, and note that a trailing-slash
pattern only matches a directory that already exists.

**The git remote is `git@github.com:shaltut/job-finder.git` — the original author's repository, not
the current owner's.** Confirm the remote before pushing.

The design specs under `docs/` were scrubbed of the real phone number, email and profile URLs, and
`test/identity.test.ts` now fails if any of them come back. **But git history still holds them**, along with
the old `SKILL.md` and its CV evidence, in every commit up to `63aed17` — which is already pushed. Sharing
this repo publicly means either accepting that or starting a fresh history.
