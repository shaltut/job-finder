# Setting this up for yourself

A personal job-search pipeline. It scrapes LinkedIn **posts** (your home feed plus a list of search terms) for
roles that carry a contact email, scores each one against your CV, stores them in a local SQLite file, and
writes tailored application emails as Gmail **drafts**. It never sends anything: you read the draft and press
send yourself.

It runs entirely on your machine. Nothing leaves it except the OpenAI scoring calls and the Gmail draft calls.

`CLAUDE.md` explains how the pieces fit together and every trap that cost real time. Read it after this file.

## What is NOT in this bundle

Deliberately absent, and none of it optional to recreate: the OpenAI key (`.env`), the logged-in Chrome
profile (`profile/`), the Gmail OAuth client and its tokens (`google-oauth.json`, `gmail-token.json`), the
database and drafts (`data/`), and the backups. You start with empty everything, which is the point — the
whole tool is built around one person's CV and one person's inbox.

## Install

Needs **Node 22+** and **Google Chrome**. No database server: SQLite is a file.

```bash
npm install
printf 'OPENAI_API_KEY=sk-...\n' > .env
npm run db:migrate      # creates data/jobfinder.db
npm test                # 72 tests; no browser, no network, no API key needed
npm run login           # log in inside the Chrome window that opens
npm run dev             # http://127.0.0.1:3939
```

Then open **Settings** and make it yours (below), and press **Start scrape** in the Run view.

## Swap these before the first run

| # | What | Where | Why it matters |
|---|------|-------|----------------|
| 1 | **Your profile and constraints** | **Settings view** (writes `config.json`) | Name, contact details, which countries are in scope, whether you will relocate, whether you can start immediately. These are injected into both the scoring prompt and the drafter, so every email states them. **Do this first.** |
| 2 | **Your evidence and gaps** | `.claude/skills/job-application-drafter/SKILL.md` | The drafter's honesty depends on this: it declares the gaps listed here and may claim nothing else. Left unedited, every draft claims someone else's projects. |
| 3 | Your CV PDF | `cv` in Settings | The scoring model reads the PDF itself once per run, and it is attached to every draft. |
| 4 | `OPENAI_API_KEY` | a new `.env` file | Scoring runs on `gpt-5-nano`; a full 9-term run costs a few cents. |
| 5 | Search terms and target titles | **Settings view** | Shipped tuned for senior frontend (Vue/Nuxt, React/Next) in Egypt and the Gulf. `terms` also contains the literal `feed`, which scrapes your own LinkedIn home feed — drop it if your feed is noise. |
| 6 | Your Google OAuth client | `google-oauth.json` | Only needed for Gmail drafting; see below. Until then drafts are written to `data/drafts/`. |
| 7 | Your LinkedIn session | `npm run login` | Logs you into the tool's own Chrome profile in `./profile`. Redo it whenever a run exits with code 2. |

**Points 1 and 2 are different jobs.** Settings holds the facts that change (contact details, where you will
work). The skill holds the argument: what you have actually built, and what you must declare that you have
not. Neither is optional, and the second one is the one that keeps your emails honest.

## Connecting Gmail (optional, and only for drafting)

Everything except Gmail delivery works without this. Skip it and drafts land in `data/drafts/*.json` for you
to copy.

1. Create a Google Cloud project, and **enable the Gmail API on the project that owns the client.** Enabling
   it on a different project is the classic failure: every call returns *"Gmail API has not been used in
   project &lt;number&gt;"*.
2. OAuth consent screen → publishing status **In production**. In *Testing*, refresh tokens die after 7 days
   and you reconnect every week.
3. Scopes: `gmail.compose` **and** `gmail.readonly`. The second is needed to read your sent mail so the tool
   knows what you actually sent; `gmail.metadata` is not enough, it rejects the search.
4. Create an OAuth client of type **Desktop app**. **There is no redirect URI field for this type** —
   Google allows loopback redirects automatically, so there is nothing here to match. This app listens on
   `http://127.0.0.1:3939/api/gmail/callback`.
5. Download the client JSON as `google-oauth.json` in the project folder, reload Settings, press
   **Connect Gmail**.

Settings shows these steps in-app, with the exact redirect URI, whenever the file is missing.

**It cannot send.** The `gmail.compose` scope does permit sending, so that is enforced in the code instead:
no send call exists anywhere under `server/`, and `npm test` fails if one is ever added.

## How you actually use it

1. **Run** → Start scrape. Nine terms, forty cards each, a few minutes. Or leave it to the daily 08:07 task.
2. **Posts** → read what came back. Filters default to unprocessed and unflagged. Press **Draft** on anything
   worth applying to.
3. **Pipeline** → read the draft. It will declare your gaps; that is deliberate. Edit it if you like, then
   send it from Gmail yourself.
4. After sending, press **Sync with Gmail**. That is what moves a recruiter from *drafted* to *contacted* and
   starts the three-day follow-up clock.

Each recruiter gets **at most two emails, ever**: the application and one follow-up after three days of
silence. Then the address is closed and the database refuses to reopen it.

## Be a good citizen of LinkedIn

The scraper drives a real headed Chrome with randomised pauses and a 40-card ceiling per term, because
scraping LinkedIn quickly is how you lose the account. A checkpoint page is treated as a lost login (exit
code 2). Don't raise the limits, don't run it in a loop, and don't point it at an account you cannot afford
to lose.

## Where the old version went

This branch replaced a Node + PostgreSQL + vanilla-JS implementation. Those files (`jobfinder.js`, `ui.js`,
`ui.html`, `scrape.js`, `schema.sql`, `com.jobfinder.plist`) are deleted here but preserved in git — read one
with `git show main:ui.js`. The design record for the rewrite is
`docs/superpowers/specs/2026-09-10-nuxt-rewrite-design.md`; the two older specs in that folder describe the
pre-rewrite system.
