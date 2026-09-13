# Job Finder

A personal job-search pipeline that runs entirely on your own machine. It scrapes LinkedIn **posts**
— content search plus your own home feed — for roles that carry a contact email, scores each one
against your CV, and drafts a tailored application email for the ones worth answering.

**It never sends anything.** Drafts are created in your Gmail with your CV attached, addressed and
ready. You read them and press send. That is a property of the code, not a promise: no send call may
exist under `server/`, and a test fails the build if one appears.

**It is not tied to a profession.** Nothing in the source names a field, a country, a stack or a
person — all of it is one row in a local SQLite database, filled in through the Settings page. A
frontend engineer in Cairo and a structural engineer in Lagos run the same code.

## What it does

| View | |
|---|---|
| **Run** | Start a scrape, watch it live, cancel it, rescore or re-flag what is stored |
| **Posts** | Everything found, scored 0-10 against your CV, filterable, with a Draft button per row |
| **Pipeline** | Who has been contacted, what stage each is at, and the drafts waiting to be sent |
| **Settings** | Your profile, constraints, CV, field and level, and the background emails argue from |

Each recruiter gets at most **two** emails, ever — an application and one follow-up — and that limit
is enforced by the database rather than by remembering.

## Requirements

- **Node 22+** (the scraper is TypeScript run directly, no build step)
- **Google Chrome** — the scraper drives your real browser, headed, in its own profile
- An **OpenAI API key** for scoring and for reading your CV
- The **`claude` CLI** for drafting
- Optionally a Google OAuth client, to create drafts in Gmail. Without one, drafts are written to
  `data/drafts/*.json` and everything else works unchanged.

## Install

```bash
npm install
printf 'OPENAI_API_KEY=sk-...\n' > .env
npm run db:migrate    # creates data/jobfinder.db
npm test              # no browser, no network, no API key needed
npm run login         # log in to LinkedIn in the Chrome window that opens
npm run dev           # http://127.0.0.1:3939
```

## First run

Open **Settings** and work down the page:

1. **Drop your CV** on the upload area.
2. Press **Prefill from CV** — it fills your name, contact details, field, skills, target titles and
   search terms from the document. It fills only what is still blank and saves nothing.
3. Fill in what a CV cannot know: which countries you would work in or relocate to, your hours,
   whether you can start immediately, and the roles that are *not* yours.
4. Press **Generate from CV** under Application background. It reads your CV against the titles you
   target and proposes the evidence an email may cite, the gaps it must declare, and what is scarce
   about you.
5. **Read every line, especially the gaps**, then press Save.

Step 5 is not a formality. Evidence that overclaims puts a lie in an email sent under your name; a
gap you do not actually have makes every application apologise for a problem you do not have. The
generator is built to make both unlikely — gaps are derived only from requirements it can tie to a
title you actually search, and anything it cannot justify is discarded and reported — but you are
the last check, and you are a better one.

Then open **Run** and start a scrape.

Connecting Gmail is a separate, longer setup with several traps in the Google Cloud console; it is
written out step by step in [SETUP.md](SETUP.md), and the same walkthrough appears in the app when no
client is configured.

## What leaves your machine

Your CV and the text of scraped posts go to the OpenAI API for scoring and for generating your
background. Draft emails go to the Gmail API. The drafting model runs through the `claude` CLI with
**no tools at all** — it receives post text and returns JSON, and cannot read a file or reach the
network. Everything else — the database, your CV, the LinkedIn session, the drafts — stays in this
folder, and `.gitignore` keeps all of it out of git.

## Be a good citizen

The scraper paces itself: a handful of search terms per run, randomised pauses, a real headed
browser. Scraping your own feed aggressively is how an account gets restricted. If a run exits with
`login expired`, LinkedIn showed a checkpoint — run `npm run login` again and scrape less that day.

## Working on it

[CLAUDE.md](CLAUDE.md) documents the architecture, the data model, and a long list of gotchas that
each cost real time to find. Start there before changing anything.

```bash
npm test           # the full suite
npm run lint
npm run typecheck
npm run dry -- --terms "senior <your role>" --max 10   # prints cards, stores nothing, no API call
```
