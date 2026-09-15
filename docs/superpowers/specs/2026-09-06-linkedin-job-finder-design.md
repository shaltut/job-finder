# LinkedIn Feed Job-Post Finder — Design

Date: 2026-09-06

## Goal

Once a day, search LinkedIn content (feed posts, not the Jobs tab) for 8 role keywords,
collect posts from the past 24 hours that include a contact email, score each post for fit
(title match, remote or MENA), and insert them into a local Postgres table. A later v2 reads the table and
drafts application emails.

## Decisions

- **Runtime:** Node.js, single script `jobfinder.js`, `playwright-core` driving the installed Chrome (no browser download)
  (`channel: 'chrome'`, headed) with its own persistent profile at `./profile`.
  User logs in once via `node jobfinder.js --login`.
- **Scheduler:** manual (`npm start`) by default. Optional launchd daily 08:00 via `npm run schedule`
  (installs `com.jobfinder.plist`, which passes `--jitter` so the run starts 0-30 min late); `npm run unschedule` removes it.
- **Searches:** 8 canonical terms, `datePosted=["past-24h"]`, no `contentType` filter
  (that filter means "posts embedding a LinkedIn Job card" and returns almost nothing).
  Terms: engineering manager · head of engineering · .net team lead · senior .net developer ·
  solution architect · hl7 fhir · health insurance technology · ai engineering manager.
- **Matching:** deterministic email pre-filter (a `mailto:` href or email regex in card text),
  then one OpenAI structured-output call per surviving post that extracts fields and scores the post
  against the candidate's CV. The CV PDF (`--cv`, default `CV_PATH`) is read by the model once per run
  (`input_file`, no local PDF parser) and its text sits in the prompt's fixed prefix, which OpenAI caches.
- **Images:** text only in v1. Posts whose email lives only in a flyer image are skipped.
  `ponytail:` ceiling — attach image bytes as base64 to the same OpenAI call when needed.
- **Dedupe key:** `sha1(author_url + first 160 chars of text)` after stripping the drifting header
  markers (age like `5h`/`1d`, Follow/Following, Edited, connection degree) and collapsing whitespace.
- **Store:** Postgres (Homebrew postgresql@15), database `jobfinder`, table `posts`, `key` is the primary key.
  `DATABASE_URL` env overrides the default `postgres://localhost/jobfinder`. Driver: `pg`.
  The table is created on first run (`CREATE TABLE IF NOT EXISTS`); inserts use `ON CONFLICT (key) DO NOTHING`.
- **Model:** `gpt-5-nano` (documented as the cheapest classification model), pinned in the config block. Secrets via Node 22 `--env-file-if-exists=.env`, no dotenv package.

## Flow per run

1. Ensure the `posts` table exists, load its keys, and extract the CV text (all before the browser opens, so a
   down database or a wrong CV path fails fast).
2. For each term open
   `https://www.linkedin.com/search/results/content/?keywords=<term>&datePosted=%5B%22past-24h%22%5D`.
   Since 2026-09-10 the literal term `feed` opens `https://www.linkedin.com/feed/` instead — the original author's own home
   feed carries recruiter posts the search terms miss, and every later step is identical (there is no
   `datePosted` filter on the feed, so its age spread is whatever the feed serves).
   If the URL lands on a login page, log `login expired` and exit code 2.
3. Scroll the `main` element with random 2–5 s pauses until the card count stops growing
   for 4 rounds or reaches 40 cards.
4. Click every "… more" button.
5. Cards = children of the container whose children each hold an author link
   (`a[href*="/in/"]` or `a[href*="/company/"]`). Per card: author name, author URL,
   age text, `innerText`, `mailto:` hrefs.
6. Pre-filter on email, dedupe, then OpenAI call returning
   `{title, company, location, is_remote, is_mena, score 0-10, reason}`; emails come from the deterministic regex, not the model.
   The prompt carries the CV text, the 25 target titles, and the MENA country list; `reason` names the strongest
   match and the biggest gap.
7. Compute pre-screen `flags` (regex mirrors of the drafter's hard skips: free-email, residency-gate, junior,
   junior-years, immediate-start, night-shift) and insert rows into `posts`. Random 10–20 s pause between terms.
8. Post a macOS notification with the row count (or the failure) via `osascript`. `--reflag` recomputes flags for
   all stored rows without any API call.

## Config block (top of jobfinder.js) and CLI parameters

`SEARCH_TERMS`, `TARGET_TITLES` (25 titles), `MENA` list, `MODEL`, `MAX_CARDS = 40`,
`DATABASE_URL`. `OPENAI_API_KEY` from `.env`.

Parsed with `node:util` `parseArgs` (unknown flags are an error):
`--terms "a,b"` overrides the search list · `--max N` cards per term · `--since past-24h|past-week|past-month` ·
`--cv path.pdf` · `--rescore` (rescore every stored post with the current CV and prompt) ·
`--dry-run` · `--login` · `--self-test` · `--jitter`. Via npm: `npm start -- --terms "hl7 fhir" --max 20`.

## Table `posts`

`key text PK, scraped_at timestamptz default now(), search_term, author, author_url, posted_age, title, company,
location text, remote boolean, mena boolean, emails text[], score smallint, reason text, text text`

## Error handling

- Login redirect: exit 2 before any write.
- A term times out or throws: log it, continue with the next term.
- OpenAI call fails for a post: insert the row anyway with null `score` and
  `reason = score_failed`, so the email is not lost.
- Postgres unreachable: the run exits 1 with the driver's error before opening the browser.
- launchd writes stdout/stderr to `./logs/`.

## Testing

- `node jobfinder.js --dry-run` — one term, prints cards and pre-filter verdicts,
  no OpenAI call, no database access.
- `node jobfinder.js --login` — opens the profile browser headed and waits for the feed URL.
- `node jobfinder.js --self-test` — asserts the email regex and dedupe key on fixed strings.
- `npm start -- --terms "engineering manager"` — one-term real run.
- `PROFILE_DIR=profile-empty npm run dry` — fresh profile, proves the login guard exits 2.

## Out of scope (v2)

Email drafting and sending, scanning comments, image OCR or vision.
