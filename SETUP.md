# Setting this up for yourself

A personal job-search pipeline: it scrapes LinkedIn posts (your home feed plus a list of search terms) for roles
that carry a contact email, scores each one against your CV, stores them in a local Postgres database, and drafts
tailored application emails as Gmail **drafts**. It never sends anything — you attach the CV and press send.

`CLAUDE.md` explains how the pieces fit together and every trap that cost real time. Read it after this file.

## What is NOT in this bundle

Deliberately absent, and none of it is optional to recreate: the OpenAI key (`.env`), the logged-in Chrome profile
(`profile/`), the Gmail OAuth client and its tokens (`google-oauth.json`, `gmail-token.json`), the database dumps
(`backups/`), and the scraped posts. You are starting with empty everything, which is the point — the whole tool is
built around one person's CV and one person's inbox.

## Swap these before the first run

| # | What | Where | Why it matters |
|---|------|-------|----------------|
| 1 | **Your profile facts** | `.claude/skills/job-application-drafter/SKILL.md`, Steps 3–5 and the Identity block | The drafter's honesty depends on this: it declares the gaps listed here. Left unedited, every draft you send claims someone else's experience, phone number and email. **Do this first.** |
| 2 | Your CV PDF | `CV_PATH` in `jobfinder.js` (or `cv` in `config.json`) | The scoring model reads the PDF itself, once per run. |
| 3 | `OPENAI_API_KEY` | a new `.env` file | Scoring runs on `gpt-5-nano`; a full 9-term run costs a few cents. |
| 4 | Search terms and target titles | `config.json` | Shipped tuned for senior .NET / architect / health-insurtech roles in MENA. `terms` also contains the literal `feed`, which scrapes your own LinkedIn home feed — drop it if your feed is noise. |
| 5 | Your Google Cloud OAuth client | `google-oauth.json` | Desktop client, scope `gmail.compose`, **Gmail API enabled on the same project that owns the client**, publishing status *In production* (in Testing, refresh tokens die after 7 days). |
| 6 | Your LinkedIn session | `npm run login` | Logs you into the tool's own Chrome profile in `./profile`. Redo it whenever a run exits with code 2. |
| 7 | Absolute paths | `com.jobfinder.plist` | Only if you want the optional daily schedule. |

## Install

Needs Node 22+, Google Chrome, and PostgreSQL 15 (Homebrew: `brew install postgresql@15 && brew services start postgresql@15`).

```bash
npm install
createdb jobfinder                 # schema.sql applies itself on first run
printf 'OPENAI_API_KEY=sk-...\n' > .env
npm run login                      # log in inside the Chrome window that opens
npm test                           # helpers only: no browser, no database, no API
npm run dry -- --terms "backend lead" --max 10    # prints cards, stores nothing
npm start                          # the real run: scrape, score, store
npm run ui                         # http://127.0.0.1:3939
```

`psql` is keg-only on Homebrew and is not on `PATH`: `/opt/homebrew/opt/postgresql@15/bin/psql -d jobfinder`.

## Then

Open the UI, connect Gmail in Settings, and use the Pipeline tab. The drafter itself is a Claude Code skill, not a
script: run `/job-application-drafter` in a session started in this folder, or press Run drafter in the UI.

## Be a good citizen of LinkedIn

The scraper drives a real headed Chrome with randomised pauses and a 40-card ceiling per term because scraping
LinkedIn quickly is how you lose the account. A checkpoint page is treated as a lost login (exit code 2). Don't
raise the limits, don't run it in a loop, and don't point it at an account you cannot afford to lose.
