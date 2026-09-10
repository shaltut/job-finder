# Nuxt rewrite — design record

**Status: implemented.** M1-M5 are built and on the `nuxt-rewrite` branch. This is the design as approved
before implementation, kept verbatim below so the reasoning behind each decision survives; the section
immediately after it records what changed once the code met reality.

---

# Job Finder → Nuxt rewrite, retargeted to Mohamed Maher

## Context

`shaltoot-job-finder` was cloned fresh. It is Ahmed Shaltoot's personal job-search pipeline: a Playwright
scraper drives real Chrome through LinkedIn **posts**, keeps the ones carrying a contact email, scores them
against a CV with `gpt-5-nano`, stores them in Postgres, and a Claude Code skill drafts application emails as
Gmail drafts. Every profile fact, search term and screening rule in it is Ahmed's.

Two jobs, and they are entangled:

1. **Make it mine.** Every hardcoded fact is wrong for this machine and this person. The tool targets senior
   .NET / architect / healthcare-claims roles for a Director of Engineering in Cairo. Mohamed Maher is a
   Senior Frontend Engineer in Damietta — Vue/Nuxt primary, React/Next secondary, 10+ years, led six
   engineers without ever holding the title.
2. **Rewrite the stack.** Nuxt 4 + Nuxt UI dashboard template, Nitro server routes for the API, SQLite
   instead of Postgres, on a `nuxt-rewrite` branch.

Setting it up as-is first would be wasted work: `SETUP.md`'s install path needs Homebrew PostgreSQL 15, which
isn't installed here and can't take port 5432 (Docker's `onebench-postgres` owns it). Moving to SQLite deletes
that problem rather than solving it. Three things found while exploring changed the shape of the design:

- **Nuxt UI v4 is fully MIT** — all 125+ Pro components are free, so the dashboard template has no licence
  question. ([Nuxt UI v4](https://nuxt.com/blog/nuxt-ui-v4), [template](https://dashboard-template.nuxt.dev/))
- **The `mcp__claude_ai_Gmail__*` MCP tools the drafter depends on are not connected here.** Rather than
  connect them, the server takes over Gmail entirely — which also deletes the repo's worst gotcha (the MCP
  draft tool corrupts a PDF passed as base64 through the model, so `ui.js` had to re-open every draft to bolt
  the CV on afterwards).
- **No data to migrate.** There is no database, no `profile/`, no `.env`, no drafts. Fresh start throughout.

Outcome: one localhost Nuxt app, `npm run dev`, that scrapes → scores → browses → screens → drafts, with the
same behaviour as the original and roughly half the hand-rolled machinery.

## Decisions taken

| Question | Decision |
|---|---|
| Where the code lives | Branch `nuxt-rewrite`, Nuxt app at the repo root; `main` keeps the Postgres version |
| Gmail | **Server owns every Gmail call.** Skill returns JSON text only — no tools, no DB, no MCP |
| Database | Drizzle ORM + `better-sqlite3`, file at `data/jobfinder.db` |
| Feature scope | All of it; the simplification comes from the framework, not from dropping features |
| Locations | Remote anywhere · Egypt onsite/hybrid · relocation to Saudi, UAE, Qatar. **Not** Europe/UK/US onsite |
| Target roles | Senior Frontend IC · Frontend/Tech Lead · EM / Head of Frontend · Full-stack (Nuxt/Next + Node) |
| Stack weighting | Vue/Nuxt primary, React/Next strong secondary |
| CV metrics | The `~30% / ~40% / ~35%` figures are **never quoted** — `resume.ts` flags them as unverified estimates |
| Availability | Can start immediately |
| Languages | Arabic native, English professional |
| Sending account | `muhamed.elrefaie@gmail.com` |

## Architecture

```
                    ┌─────────────────────────────────────────┐
  npm run dev  ───► │  Nuxt 4  ·  Nuxt UI dashboard template   │
                    │  app/   Posts · Pipeline · Run · Settings│
                    └───────────────────┬─────────────────────┘
                                        │  $fetch
                    ┌───────────────────▼─────────────────────┐
                    │  server/api/**        (Nitro routes)     │
                    │  server/tasks/**      (scheduled cron)   │
                    │  server/utils/gmail   (REST, sole owner) │
                    │  server/utils/jobs    (2 lanes + queue)  │
                    └───┬──────────────┬──────────────┬────────┘
             spawn      │              │ sole writer  │ spawn
                        ▼              ▼              ▼
              scraper/run.js    data/jobfinder.db   claude -p
              (Playwright,       (Drizzle, WAL,     (drafter skill,
               headed Chrome,     read-only to       zero tools,
               OpenAI scoring)    the scraper)       JSON in → JSON out)
```

**Why the scraper stays a child process.** It drives headed Chrome for minutes against a persistent profile
and must respond to SIGTERM for the UI's Stop button. Running it inside Nitro would block the dev server and
lose the existing `stopping`-flag shutdown. Keeping `ui.js`'s proven two-lane model: the **scrape lane** (one
at a time — Chrome profile lock) and the **draft lane** run concurrently, everything else queues.

**SQLite concurrency — server is the sole writer.** The scraper opens the database **read-only** (to know
which keys it can skip re-scoring) and emits scored rows as NDJSON on stdout; the server parses and inserts.
`PRAGMA journal_mode = WAL` and `busy_timeout` on both connections. This keeps Drizzle as the single write
path and avoids two processes racing for a write lock.

`--rescore` and `--reflag` (both carried over) *update* existing rows, which a read-only scraper cannot do, so
they use the same channel: the scraper emits `{op:'update', key, score, reason}` / `{op:'reflag', key, flags}`
lines and the server applies them. Worth settling in M1 rather than discovering mid-port.

## Data model — `server/db/schema.ts`

Three tables, same shape as `schema.sql`, translated off Postgres:

| Postgres | SQLite |
|---|---|
| `emails text[]`, `flags text[]` | `text({ mode: 'json' }).$type<string[]>()` |
| `cardinality(flags) = 0` | `json_array_length(flags) = 0` |
| `$email = ANY(p.emails)` | `EXISTS (SELECT 1 FROM json_each(posts.emails) WHERE value = ?)` |
| `timestamptz` | `integer({ mode: 'timestamp' })` |
| `contacts.email` lower-case constraint | `CHECK (email = lower(email))` — same guarantee |
| `ON CONFLICT … WHERE contacts.stage <> 'final'` | identical; SQLite supports partial upserts |

- `posts` — `key` (sha1 of author_url + first 160 chars, header markers stripped), `score` 0-10, `reason`,
  `emails`, `flags`, `postedAt`. The `mena` column is renamed **`inScope`** — the scope is now Egypt + Saudi +
  UAE + Qatar + remote, not all of MENA. Fresh database, so no migration.
- `applications` — one row per post touched. `reason` for drafted posts keeps the `named in application` /
  `named in follow-up` prefix; the follow-up query depends on it.
- `contacts` — `stage` drafted → contacted → followed_up → final, or replied. **Two emails per address, ever.**

Backups become `cp data/jobfinder.db backups/jobfinder-<date>.db`, newest 14 kept — replacing `pg_dump`.

## Skill / server boundary

This is the heart of the rewrite. Everything deterministic moves into TypeScript; the skill does only the part
that needs judgement.

| Old SKILL.md step | Now lives in |
|---|---|
| 1 — load posts, group by recruiter | **Server.** Drizzle query; groups by `emails[0]` before calling the skill |
| 1a — stage sweep | **Server.** `server/utils/gmail.ts` reads sent mail directly |
| 1b — the 8-row Gmail decision table | **Server.** A pure function + unit test; no model judgement in it |
| 2 — screen (hard skips, soft flags) | **Skill** |
| 3-6 — profile facts, gaps, constraints, write the email | **Skill** |
| 7 — create the draft, attach CV, record verdicts | **Server.** One `gmail.drafts.create` with the PDF attached |
| 8 — report | **Skill** |

**Contract.** The server spawns `claude -p` with post text on stdin and gets back exactly:

```jsonc
{
  "results": [{
    "key": "<sha1>", "verdict": "drafted" | "skipped", "reason": "…",
    "recruiter_email": "…",
    "subject": "…", "body": "…",                // plain text; present only when drafted
    "gaps_declared": ["react-depth", "no-lead-title"]
  }],
  "report": "markdown for the Run view"
}
```

The model returns **plain text only** — no `html` field. The server owns MIME anyway, so it renders the HTML
part itself (`\n` → `<br>`, signature links from a fixed template). That guarantees a consistent signature,
deletes the original's "Gmail rewrites bare URLs into `google.com/url?q=` redirects" gotcha at the source, and
removes a whole class of instruction ("write `&`, not `&amp;`") from `SKILL.md`.

A `mode: "follow-up"` variant asks for the shorter follow-up body instead. The server validates the JSON,
creates the draft, and writes `applications` + `contacts` in one transaction.

**Invocation.** `claude -p --strict-mcp-config --mcp-config '{"mcpServers":{}}'`, no tools allowed, with
`SKILL.md` injected via `--append-system-prompt`. This machine has ~10 MCP servers (chrome-devtools,
playwright, figma, claude-mem…); skipping them removes both the 3-5 minute startup and all tool risk. **The
whole `settings.local.json` allow-list inheritance gotcha in `CLAUDE.md` disappears** — with no tools granted
there is nothing for an inherited allow rule to re-enable. M3 verifies the skill still loads this way before
the design is locked in.

## Invariants (each gets a runnable check)

1. **Never sends.** `gmail.compose` *includes* send permission, so never-sending is now a property of the
   code, not of the credential. No `messages.send` / `drafts.send` call may exist under `server/`; a test
   greps for it. Scopes requested: `gmail.compose` + `gmail.readonly` (the `gmail.metadata` scope rejects the
   `q=` search parameter the stage sweep needs).
2. **Two emails per recruiter, ever.** `final` is never reset; enforced by the upsert's `WHERE` clause.
3. **The sender address is discovered, not hardcoded.** The stage sweep decides "already contacted?" by
   matching the sender on sent mail, so a wrong constant would silently make every sent application look
   unsent. At connect time the server reads `users/me/profile` and stores `emailAddress` with the token;
   `muhamed.elrefaie@gmail.com` becomes the *expected* value it warns against, not a literal in the code.
4. **`emails` comes from a regex, never from the model.**
5. **The dedupe key is stable across runs** — Arabic age folding (`٣ من الساعات` → `3h`) and header-marker
   stripping are ported verbatim from `jobfinder.js`; `npm test` keeps its existing assertions.
6. **Reposts key to the real author** — `readCards` picks the *most repeated* href, not the first.

## Config — `config.json`, edited from the Settings page

**Everything below is editable in the UI's Settings view and ships pre-filled with Mohamed Maher's values as
defaults.** Nothing here is hardcoded in the source: `config.json` is the single place these live, the
Settings page is a form over it, and both the scoring prompt and the drafter's system prompt are built from it
at run time. Changing your phone number or dropping a search term is a UI edit, not a code change.

The original only exposed `terms` / `titles` / `max` / `since`; the identity and constraints were baked into
`jobfinder.js` and `SKILL.md`. Widening `config.json` is what makes the "make it mine" half of this job a
one-time data entry rather than a permanent editing chore.

```jsonc
{
  "profile": {                                  // → scoring prompt + drafter system prompt + email signature
    "name": "Mohamed Maher",
    "title": "Senior Frontend Engineer",
    "location": "Damietta, Egypt",
    "email": "muhamed.elrefaie@gmail.com",
    "phone": "+20 101 702 6444",
    "linkedin": "https://www.linkedin.com/in/mohamed-maher-b620ba139/",
    "github": "https://github.com/melrefaie",
    "languages": "Arabic native, English professional",
    "yearsExperience": "10+"
  },
  "constraints": {                              // → hard skips in the drafter, is-in-scope in the scorer
    "remoteAnywhere": true,
    "onsiteCountries": ["Egypt", "Saudi Arabia", "UAE", "Qatar"],
    "willRelocate": ["Saudi Arabia", "UAE", "Qatar"],
    "canStartImmediately": true,
    "workingHours": "09:00-21:00 Africa/Cairo",
    "stackWeighting": "vue-primary"             // vue-primary | equal | react-primary
  },
  "cv": "/Volumes/Data/projects/CV/app/mohamed-maher-cv/Mohamed-Maher-CV.pdf",
  "terms":  [ /* 9, below */ ],
  "titles": [ /* 30, below */ ],
  "max": 40,
  "since": "past-24h"
}
```

**Settings view** — one page, four cards: **Profile** (text fields), **Constraints** (country toggles,
availability switch, stack-weighting radio), **Search** (terms and titles as editable chip lists, `max`
slider, `since` select, CV file path with an "is this file there?" check), **Gmail** (connect button,
connected-account display, and the mismatch warning from invariant 3). Saves via `PUT /api/config`, validated
server-side exactly as `validateConfig` does today — a bad CV path or an empty terms list is rejected with a
readable message rather than written.

Seed lists, to be re-tuned from the Run view's yield table after the first week (that is how the original
lists were arrived at). `feed` stays: it scrapes `linkedin.com/feed/` instead of a search.

**terms** — `feed`, `senior frontend engineer`, `hiring frontend developer`, `vue nuxt developer`,
`react next.js developer`, `frontend team lead`, `frontend engineer saudi`, `frontend developer remote`,
`frontend engineer egypt`

**titles** (30, for the scoring prompt) — Senior Frontend Engineer · Senior Frontend Developer · Frontend
Engineer · Frontend Developer · Senior Vue.js Developer · Vue.js Engineer · Nuxt Developer · Senior React
Developer · React Engineer · Next.js Developer · Senior JavaScript Engineer · Senior TypeScript Engineer ·
Frontend Team Lead · Frontend Lead · Lead Frontend Engineer · Frontend Tech Lead · Technical Lead (Frontend) ·
Head of Frontend · Frontend Engineering Manager · Engineering Manager (Frontend) · Staff Frontend Engineer ·
Principal Frontend Engineer · Senior UI Engineer · Senior Web Developer · Frontend Architect · Design System
Engineer · Full Stack Developer (Vue/Node) · Full Stack Engineer (Next.js) · Senior Full Stack Developer ·
Senior Software Engineer (Frontend)

**`FLAG_RULES`** — keep `residency-gate`, `junior`, `junior-years`, `night-shift`. Add `wordpress-only`
(frontend searches surface heavy WordPress/Shopify piecework; his WP work is 2014-2017 and dated).

**Remove `immediate-start` entirely** — a deliberate deviation from what I described when asking. Flags demote
posts in both the UI sort and the drafter queue, so keeping it "for visibility" would push good posts down for
a trait that is now an *advantage*. Immediate availability instead becomes a line the drafter may use.

## Drafter profile — `.claude/skills/job-application-drafter/SKILL.md`

Rewritten from `/Volumes/Data/projects/CV/app/mohamed-maher-cv/app/data/resume.ts` (the single source of
truth; `Mohamed-Maher-CV.pdf` is generated from it by `scripts/generate-pdf.mjs`).

**Identity and constraints are NOT written into this file** — the server injects them from `config.json`'s
`profile` and `constraints` blocks when it builds the system prompt, so editing them in Settings changes the
drafts immediately. `SKILL.md` holds only the prose that needs judgement: evidence, gaps, screening rules,
tone. For reference, the injected identity is Mohamed Maher · Damietta, Egypt · +20 101 702 6444 ·
muhamed.elrefaie@gmail.com · linkedin.com/in/mohamed-maher-b620ba139 · github.com/melrefaie · Arabic native,
English professional. B.Sc. Computer Science, Damietta University (2016) stays in the file — it is a fact
about the past, not a setting.

**Evidence (hard facts only — no estimated percentages).** Senior Frontend Engineer at OneBench (Jan 2026-,
remote), Managed Services (2025-2026), Baianat (2014-2025). Led a **6-engineer frontend team for 11 years**;
**100+ production platforms**; **20+ WordPress client sites** 2014-2017 before moving the team to Vue/Nuxt; a
SOC monitoring dashboard surfacing **1,000+ real-time security events** with sub-second filtering; React 19 +
Next.js 16 compliance platform with full i18n (managed.sa); Tatmeen, a virtual healthcare platform **licensed
by the Saudi MOH**; FRA Sandbox, a fintech regulatory ecosystem; Workens, three role-based dashboards plus a
marketing site in one pnpm monorepo on a shared Nuxt layer; a cross-project design system in Vue/Nuxt/Angular;
EN/AR RTL i18n across several products.

**Gaps — declared, never papered over.**
- **Never held a Lead or Manager title.** Led six engineers for eleven years as a senior IC. Fixed sentence
  when applying to Lead/EM: *"I have not carried a Lead or Manager title, though I led a six-engineer frontend
  team at Baianat for eleven years; I am applying at this level deliberately and would rather you weigh the
  scope than the title."*
- **React/Next is ~1 year** (React 19 / Next 16, 2025-2026) against ~11 years of Vue/Nuxt. Say so plainly
  against any 5+ years React requirement.
- **Angular is dated** — Baianat-era, not current.
- **No cloud, database, DevOps or CI/CD anywhere on the CV** — no AWS/GCP/Azure, Docker, Kubernetes, SQL/NoSQL
  or pipelines. Full-stack applications must declare this: "Full-Stack Developer" on six projects means
  Directus/GraphQL-backed frontends, not backend systems engineering.
- **No named test framework beyond Jest** — no Playwright, Cypress, Vitest or Testing Library on the CV.
- **No certifications, awards or courses. No mobile** (React Native, Flutter), no Svelte, no Astro.
- **The `~%` figures in the CV are unverified estimates** and never enter an email.

**Constraints.** Remote anywhere · Egypt onsite/hybrid · relocation to Saudi, UAE, Qatar only · **can start
immediately** · working hours roughly 09:00-21:00 Cairo (EET/EEST).

**Prioritise** posts asking for what is genuinely scarce in him: Vue/Nuxt at depth · SSR and Core-Web-Vitals
performance work · design systems · EN/AR RTL i18n · GraphQL-first frontends · Directus/headless CMS ·
monorepos · Arabic + Gulf market familiarity.

Carries the same snapshot warning as the original: if `resume.ts` changes, this file must change with it.

## Milestones

**M1 — Scaffold + data + scraper.** Branch `nuxt-rewrite`. Scaffold `npm create nuxt@latest -- -t ui/dashboard`
into a temp dir, move to the repo root, delete the stray `pnpm-lock.yaml` (**npm, not pnpm** — corepack's pnpm
is broken on this machine). **Merge, don't overwrite, the two files the template also ships:** `.gitignore`
must keep `profile/` (a live LinkedIn session), `.env`, `google-oauth.json`, `gmail-token.json`, `backups/`,
`drafts/`, `jobs.csv`, and gain `data/`; `package.json` must keep `login` / `test` / `scrape` scripts, or the
`npm run login` prerequisite has nothing to run. Drizzle schema + migration. Port `jobfinder.js` →
`scraper/run.js` unchanged in behaviour, emitting NDJSON. Posts view.
*Needs: `.env` with `OPENAI_API_KEY`, then `npm run login`.*

**M2 — Run + Settings + job lanes.** `server/utils/jobs.ts` (two lanes, queue, SIGTERM stop), log streaming,
KPI strip, yield-by-term table, and the **full Settings view** — Profile, Constraints, Search and Gmail cards
over the widened `config.json`, seeded with the Mohamed Maher defaults above and validated server-side on save.

**M3 — Drafter.** Rewrite `SKILL.md` off `resume.ts`. `server/utils/drafter.ts` spawns `claude -p` with zero
tools and validates the JSON. **Verify the skill loads with `--strict-mcp-config` and no tools before going
further.** Drafts stored locally in `data/drafts/` at this stage — M1-M3 need no Google Cloud at all.

**M4 — Gmail + Pipeline.** OAuth **loopback-redirect** flow — a Desktop client redirecting to
`server/api/gmail/callback.get.ts` on `http://localhost:3000`. (Not the device flow: Google's limited-input
device flow does not support Gmail scopes, only Drive/YouTube/OpenID.) `ui.js` already has a flow that
authenticated successfully — port it rather than redesign. **Port its `state` nonce too** (upstream commit
`e8be7b6`): Google's redirect into the callback is itself a cross-site GET, so the Origin / Sec-Fetch-Site
guard must exempt GETs and cannot protect it; without a one-shot random `state`, any page open in the browser
can feed the server its own `code` and have the drafts written into its mailbox. Verify with a forged
callback: 400, and `gmail-token.json` untouched. Then `gmail.drafts.create` with the CV attached in
one call, the 8-row stage machine as a tested pure function, Pipeline view with follow-up countdowns,
`scheduledTasks` cron replacing launchd, `.db` backups. *Needs: the Google Cloud OAuth client.*

**M5 — Docs + cleanup.** Rewrite `CLAUDE.md` and `SETUP.md` for the new stack and person — including that the
skill is now **server-invoked only** (with Steps 1/1a/1b/7 in TypeScript, running `/job-application-drafter`
interactively has no database and no Gmail; the route is "press Run drafter in the UI"). Delete `jobfinder.js`
/ `ui.js` / `ui.html` / `scrape.js` / `schema.sql` / `com.jobfinder.plist`, copy this design to
`docs/superpowers/specs/2026-09-10-nuxt-rewrite-design.md`, commit.

## Verification

- `npm test` — ported helper assertions (dedupe key stability, Arabic age folding, email extraction, the
  8-row stage table) **plus** the never-send grep over `server/`.
- `npm run dev` → http://localhost:3000 — drive all four views with Playwright screenshots. (Note: the
  Claude-in-Chrome extension cannot open localhost; use `chromium.launch({ channel: 'chrome', headless: true })`
  from this folder's `node_modules`, as `CLAUDE.md` records.)
- Settings round-trip: edit a term and the phone number in the UI, save, reload — the values persist in
  `config.json`, the next scrape uses the new term, and the next draft carries the new phone number. Then try
  saving an empty terms list and a non-existent CV path and confirm both are rejected with a readable error.
- `node scraper/run.js --dry-run --terms "senior frontend engineer" --max 10` — prints cards, stores nothing,
  no OpenAI call.
- `PROFILE_DIR=profile-empty node scraper/run.js --dry-run` — must exit 2 with `login expired`.
- One real `npm start`-equivalent scrape, then check the Posts view and the yield table.
- M4: create one draft to a throwaway address, confirm in Gmail that the PDF is attached and the message is
  in Drafts, not Sent.

## Manual prerequisites (yours, not mine)

1. `printf 'OPENAI_API_KEY=sk-...\n' > .env`
2. `npm run login` — log into LinkedIn in the Chrome window that opens (needed before M1 can be tested).
3. **Google Cloud, before M4** — a project, **Gmail API enabled on the same project that owns the client**, an
   OAuth *Desktop* client, consent screen set to **In production** (in Testing, refresh tokens die after 7
   days), scopes `gmail.compose` + `gmail.readonly`. Save as `google-oauth.json`.

## Two things to know

- **Your CV PDF is 1.38 MB**, against the 75 KB the original was built around. Fine for Gmail and for the
  OpenAI file read, but every application carries it.
- **The attached PDF contains the `~%` estimates the drafter refuses to quote.** The email will be honest and
  the attachment slightly less so. Worth replacing them with real figures in `resume.ts` and regenerating —
  and adding a languages section while you're there, since Arabic/English are not on the CV at all today.

---

## What changed during implementation

The design held. Six things were learned or corrected by building it:

1. **`--allowed-tools` and `--disallowed-tools` are variadic.** A flag following one with no values of its
   own is swallowed as a tool name, which silently dropped `--append-system-prompt` *and* left Bash enabled.
   `--allowed-tools` also refuses an empty list, so the allow list names a tool that does not exist.
   The plan assumed passing "no tools" would be straightforward; it is not.
2. **`claude -p` loads the CLAUDE.md of its working directory.** The drafter read the project's file, which
   still described the previous owner, and used his name in a report. It now runs from an empty temp
   directory — it has no tools, so it needs nothing from the project folder.
3. **Nitro's dev HMR reloads server modules on every edit**, which orphaned a running scrape: the child kept
   writing rows while the UI showed an idle lane and Stop had nothing to kill. Job lane state and the OAuth
   nonce both live on `globalThis` for this reason.
4. **A skip could downgrade a `drafted` verdict.** Re-drafting a recruiter with a pending draft rewrote the
   verdict to `skipped`, destroying the `named in ...` prefix the follow-up query depends on — the recruiter
   would later have been told about a role the first email already covered.
5. **The OAuth `state` nonce had to be ported, not invented.** Upstream commit `e8be7b6` (by the original
   author, arriving mid-rewrite) fixes a real hole: Google's redirect into the callback is itself a
   cross-site GET, so an Origin / Sec-Fetch-Site guard must exempt GETs and cannot protect it.
6. **`@unovis` was dropped** from the template — it pulls `maplibre-gl` with a critical XSS advisory whose
   fix needs a major bump `@unovis` cannot take, and nothing here renders a map or a chart.

Two plan items were deliberately not carried out as written:

- **`immediate-start` was removed from the flag rules entirely**, not merely downgraded. Flags demote posts
  in both the UI sort and the drafter queue, so keeping it "for visibility" would have pushed good posts down
  for what is now an advantage.
- **The dev server is pinned to port 3939, not 3000**, which port 3000 being taken on this machine forced.
  The Gmail redirect URI follows it.

## Known gaps

- The Google round trip — token exchange, refresh, real draft creation, a real sweep — is written and unit
  tested but has never run against Google, because `google-oauth.json` does not exist yet.
- The **Usable** KPI counts `score >= 6 AND no flags AND (in_scope OR remote)`, so a strong role whose post
  never states a location is excluded from the headline number. It still appears in the Posts list.
- There is no repair path for a Gmail draft created while the CV path was wrong. The original had an
  "attach CV to waiting drafts" pass; here the CV is attached at creation and verified, so the fix is to
  delete the draft and re-run.
