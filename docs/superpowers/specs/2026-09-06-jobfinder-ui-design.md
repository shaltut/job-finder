# Job Finder UI — Design

Date: 2026-09-06. Builds on `2026-09-06-linkedin-job-finder-design.md` (scraper, Postgres store) and the
`job-application-drafter` skill (`.claude/skills/job-application-drafter/SKILL.md`).

## Goal

A single-user web page on localhost to browse and rank scraped posts, track the per-recruiter pipeline, act on
rows without SQL, run the scraper with parameters, edit its settings, and trigger the drafter skill.

## Decisions

- **Files:** `ui.js` (Node 22: `node:http`, `node:child_process`, the installed `pg`; no new dependencies) and
  `ui.html` (plain HTML, CSS and JavaScript using `fetch`; no framework, no build step). `config.json` holds
  the editable settings. `npm run ui` starts it; it prints `http://127.0.0.1:3939`.
- **Binding:** 127.0.0.1 only. No authentication. Not for exposure beyond this Mac.
- **Scraper change (the only one):** `jobfinder.js` reads `config.json` when present for the defaults of
  `SEARCH_TERMS`, `TARGET_TITLES`, `MAX_CARDS`, `SINCE`; command-line flags still override. `config.json` is
  written once now from the current constants.
- **One job at a time.** A single in-memory `job` record `{kind, args, startedAt, endedAt, exit, log[]}`; starting
  another while one runs returns 409. The Chrome profile cannot be shared anyway.
- **Draft runs** spawn the Claude Code CLI headless in the project folder:
  `claude -p "<prompt>" --output-format text --allowedTools <list> --disallowedTools <list>`.
  Allowed: `Read`, `Skill`, `ToolSearch`, `Bash`, `mcp__claude_ai_Gmail__create_draft`,
  `mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Gmail__get_thread`, `mcp__claude_ai_Gmail__list_drafts`.
  Explicitly disallowed: `mcp__claude_ai_Gmail__send_message`, `mcp__claude_ai_Gmail__reply`,
  `mcp__claude_ai_Gmail__forward`, `mcp__claude_ai_Gmail__trash_message`, `mcp__claude_ai_Gmail__trash_thread`.
  Prompt: "Use the job-application-drafter skill. Process the top N unprocessed posts." or
  "... process only the post whose key is <key>." Verified on 2026-09-06 that a headless session in this folder
  sees the Gmail tools and the skill.
- **Tables** `applications` and `contacts` are created if missing at startup, with the skill's DDL, so the
  pipeline view works before the first drafter run.

## HTTP API (all JSON; errors are `{error}` with 4xx/5xx)

| Method, path | Does |
|---|---|
| `GET /` | serves `ui.html` |
| `GET /api/posts?min=&mena=&remote=&unprocessed=&q=` | posts left-joined to `applications` and `contacts`: key, score, title, company, location, remote, mena, emails, posted_age, scraped_at, verdict, verdict_reason, stage; ordered by score desc, scraped_at desc; `q` matches title, company, author or text |
| `GET /api/posts/:key` | one post with full text and reason |
| `POST /api/posts/:key/skip` `{reason}` | upsert `applications` as `skipped`, reason `manual: <reason>` |
| `GET /api/contacts` | one row per recruiter: email, stage, last_sent_at, due_at (last_sent_at + 72 h), note, post_count, updated_at |
| `POST /api/contacts/:email/final` `{note}` | upsert stage `final`, note `manual: <note>` |
| `POST /api/contacts/:email/note` `{note}` | set note |
| `GET /api/config`, `PUT /api/config` | read or replace `config.json`; PUT validates: `terms` non-empty string array, `titles` string array, `max` integer 1-200, `since` one of past-24h, past-week, past-month |
| `POST /api/run/scrape` `{terms?, max?, since?}` | spawn `node --env-file-if-exists=.env jobfinder.js` with flags; 409 if busy |
| `POST /api/run/draft` `{n?, key?}` | spawn the headless drafter as above; 409 if busy |
| `GET /api/job` | current or last job, log capped to the last 300 lines |
| `POST /api/job/stop` | SIGTERM the running child |

## Page

Three tabs in one file.

- **Posts.** Filter bar (min score, MENA, remote, unprocessed only, search box). Table sorted by score. Clicking a
  row expands the full text, reason, recruiter email and stage. Row buttons: Skip (asks for a one-line reason),
  Draft this one.
- **Pipeline.** "To send" list first: recruiters at stage `drafted` or `followed_up` (drafts waiting in Gmail).
  Then all recruiters with stage, last sent, due date, post count, note; buttons Mark final, Edit note.
- **Run and settings.** Scrape form prefilled from config (terms, max, since), Run scrape button; Draft top N
  form; a log pane polling `GET /api/job` every 2 s while a job runs, kept after it ends; Stop button. Below it,
  the settings editor (terms, titles as one per line, max, since) with Save.

Colours follow `prefers-color-scheme`. No icons, no library.

## Error handling

- Postgres unreachable: every API call returns 500 with the driver message; the page shows it in a banner.
- Child process fails to spawn or exits non-zero: captured in the job log with the exit code; the page shows the
  code next to the log.
- Busy: 409 with the running job's kind; the page disables both Run buttons while `GET /api/job` reports running.
- Bad config: 400 listing the failing field; nothing written.

## Testing

- `npm test` still passes (config read has a self-test assertion).
- `npm run ui`, then `curl` each endpoint once, including a 409 while a scrape runs and a 400 on bad config.
- Screenshot of each tab in Chrome via the browser tools, with real data.
- One real draft run from the button with N = 1, checked in Gmail.

## Out of scope

Authentication, multi-user, hosted deployment, server-sent events, editing the skill file from the page,
scheduling from the page (launchd via `npm run schedule` stays).

## Revision 2026-09-07: dashboard layout

Redesigned with the ui-ux-pro-max design system (persisted at `design-system/job-finder/MASTER.md`, Data-Dense
Dashboard, density 8, motion 2). Left sidebar with count badges replaces the tabs; a global job bar in the header
shows the running job with Stop on every view; Posts gains a KPI strip fed by `GET /api/stats` (posts, unprocessed,
in-scope 7+ clean, drafts to send, follow-ups due, replied, last scrape); Skip and Draft are row-level and keep
the user on Posts; the expanded row shows text and reasoning side by side; Pipeline shows stage badges and
follow-up countdowns; Run is two cards plus the log; Settings is its own view. Tokens, Fira Sans/Fira Code,
inline SVG icons, focus-visible rings, reduced-motion support, sidebar collapses under 900px.

## Revision 2026-09-07: CV attachment through the Gmail API

`ui.js` talks to the Gmail REST API directly (OAuth 2 Desktop client, loopback redirect `/api/gmail/callback`,
scope `gmail.compose` plus `userinfo.email`, tokens in `gmail-token.json` mode 0600). `attachCv()` lists up to 50
drafts, keeps those whose To address is in `contacts`, skips any that already carry a PDF part, rebuilds the rest as
`multipart/mixed` (text and HTML alternatives preserved, In-Reply-To and References preserved, RFC 2047 subject)
with the CV from `config.cv` or the default path, updates the draft in place with the same threadId, then re-reads
it and compares the attachment size to the file. It runs automatically after draft and sync jobs and via
`POST /api/gmail/attach`; `GET /api/gmail/status`, `GET /api/gmail/auth`, `POST /api/gmail/disconnect` complete
the surface. `node ui.js --self-test` checks the MIME builder.

## Revision 2026-09-08: code-review fixes

Ten confirmed review findings closed. Security: the headless drafter now runs with `--permission-mode dontAsk`,
allows only `Bash(/opt/homebrew/opt/postgresql@15/bin/psql:*)` in the shell, and carries an explicit deny list
(shell prefixes such as curl, rm, node, python, echo; WebFetch/WebSearch; every Gmail/Outlook/Slack/Teams sending
tool), because the user-level allow list is inherited and only deny rules outrank it; `route()` refuses wrong-Host
and cross-site non-GET requests and validates `n`. Correctness: Skip cannot overwrite a drafted verdict; the skill
lists drafts before creating one and writes its rows right after; `final` is protected by `WHERE stage <> 'final'`
and a lower-case constraint; Stop actually stops the scraper (SIGTERM flag); the attacher touches only waiting
recruiters, judges PDFs by MIME type, keeps Bcc/Reply-To; the email regex trims a glued `.Word`; the schema moved
to `schema.sql` shared by both processes so the UI starts on a fresh database; scoring failures are retried instead
of stored; empty titles are rejected; Settings Save keeps `cv`; junior-years only counts experience phrases.
