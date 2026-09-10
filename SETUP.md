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
| 1 | **Your profile and constraints** | **Settings view** (writes the `settings` row in the database) | Drop your CV on the upload area, press **Prefill from CV**, then fill in the rest: which countries are in scope, whether you will relocate, whether you can start immediately. Prefill fills only blank fields and never the constraints — a CV cannot know them. These are injected into both the scoring prompt and the drafter, so every email states them. **Do this first.** |
| 2 | **Your evidence and gaps** | `.claude/skills/job-application-drafter/SKILL.md` | The drafter's honesty depends on this: it declares the gaps listed here and may claim nothing else. Left unedited, every draft claims someone else's projects. |
| 3 | Your CV PDF | `cv` in Settings | The scoring model reads the PDF itself once per run, and it is attached to every draft. |
| 4 | `OPENAI_API_KEY` | a new `.env` file | Scoring runs on `gpt-5-nano`; a full 9-term run costs a few cents. |
| 5 | Search terms and target titles | **Settings view** | Shipped tuned for senior frontend (Vue/Nuxt, React/Next) in Egypt and the Gulf. `terms` also contains the literal `feed`, which scrapes your own LinkedIn home feed — drop it if your feed is noise. |
| 6 | Your Google OAuth client | `google-oauth.json` | Only needed for Gmail drafting; see below. Until then drafts are written to `data/drafts/`. |
| 7 | Your LinkedIn session | `npm run login` | Logs you into the tool's own Chrome profile in `./profile`. Redo it whenever a run exits with code 2. |

**Points 1 and 2 are different jobs.** Settings holds the facts that change (contact details, where you will
work). The skill holds the argument: what you have actually built, and what you must declare that you have
not. Neither is optional, and the second one is the one that keeps your emails honest.

## Connecting Gmail

**Optional.** Everything else works without it — drafts land in `data/drafts/*.json` with a Copy button in
the Pipeline view. Connecting Gmail buys you two things: drafts created in Gmail with the CV already
attached, and the stage sweep, which reads your *sent* mail so follow-ups fire on their own.

It takes about fifteen minutes and the Console fights you at three points. Every one of those is called out
below. Do the steps in this order — several of them are blocked until an earlier one is finished.

### 1. Create a project

[console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)

Any name (`jobfinder-local`). **Remember which project it is** — the next step is where this usually goes
wrong.

### 2. Enable the Gmail API — on that same project

[console.cloud.google.com/apis/library/gmail.googleapis.com](https://console.cloud.google.com/apis/library/gmail.googleapis.com)

Check the project picker at the top says your project, then **Enable**. Enabling it on a different project
than the one that owns the OAuth client is the classic failure: every call then returns
*"Gmail API has not been used in project &lt;number&gt;"*.

> **Trap 1 — ignore the "Create credentials" banner.** After enabling, the page offers a credentials wizard.
> One of its paths creates a **service account**, which cannot work here: service accounts only reach Gmail
> through domain-wide delegation, which requires Google Workspace. On a personal `@gmail.com` you would
> complete the whole flow and find it never authenticates. Leave that banner alone.

### 3. Branding — do this before anything else

[console.cloud.google.com/auth/branding](https://console.cloud.google.com/auth/branding)

The OAuth consent screen is now called **Google Auth Platform**, split into Branding / Audience / Clients /
Data Access. Fill in:

- **App name** — `Job Finder`
- **User support email** — your own address
- **Developer contact information** — your own address

> **Trap 2 — Publish is greyed out until Branding is complete.** If you go to Audience first, the Publish
> button is disabled with only a vague pointer back here.

### 4. Data Access — add three scopes

[console.cloud.google.com/auth/scopes](https://console.cloud.google.com/auth/scopes)

**Add or remove scopes**, then paste each of these into the filter box and tick it:

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/gmail.compose` | create drafts |
| `https://www.googleapis.com/auth/gmail.readonly` | read *sent* mail, so the sweep knows what you sent |
| `https://www.googleapis.com/auth/userinfo.email` | read back which account connected |

Update, then **Save**. The first two are labelled **Restricted** — expected, and fine for a personal app.

`gmail.metadata` is *not* a substitute for `gmail.readonly`: it rejects the `q=` search the sweep needs.
Without `userinfo.email` the app cannot tell which account you connected, and the safety check that warns
about connecting the wrong mailbox goes quiet.

### 5. Audience — Testing or In production

[console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)

User type is **External** (a personal Gmail account cannot use Internal). Now choose:

| | Stay in **Testing** | **Publish app** → In production |
|---|---|---|
| Extra requirements | none | a working **homepage URL** and **privacy policy URL** |
| Who can connect | only addresses you add under **Test users** | you |
| Consent screen | clean | "Google hasn't verified this app" once |
| **Refresh token** | **expires after 7 days** — reconnect weekly | **persists** |

> **Trap 3 — publishing demands two real URLs.** *"Valid app name, support email, homepage url, and privacy
> policy url are required for switching the app to external production mode."* There is no way around it. If
> you have any published site, point them at it and add a short privacy page saying the tool runs locally and
> collects nothing. If you do not, stay in Testing.

**Either way, add yourself under Test users** — it costs nothing and lets you connect even if publishing is
blocked.

If you publish, a banner appears: *"Your app requires verification… submit your app for review."*
**Ignore it.** Verification is for apps with real users. Unverified + In production is the correct resting
state for a one-user tool; the only consequence is the warning screen in step 8.

### 6. Create the OAuth client

[console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients)

**Create OAuth client** → Application type **Desktop app** → Create.

> **Trap 4 — there is no redirect URI field, and that is correct.** Desktop clients get loopback redirects
> automatically; Google accepts `http://127.0.0.1:<any port>/<any path>`. The downloaded file will say
> `"redirect_uris": ["http://localhost"]` while this app calls back on
> `http://127.0.0.1:3939/api/gmail/callback`. That mismatch is fine — Google treats the two hosts as
> equivalent for Desktop clients and ignores the port.

### 7. Download and rename

**Download JSON**. Google names it `client_secret_<long-id>.apps.googleusercontent.com.json`. Rename it to
exactly **`google-oauth.json`** in the project folder. It is gitignored; confirm with
`git check-ignore google-oauth.json`.

### 8. Connect

Reload **Settings** and press **Connect Gmail**. If you published, you will see **"Google hasn't verified
this app"** → **Advanced** → **Go to Job Finder (unsafe)**. Grant both permissions.

Do not restart the dev server between pressing Connect and finishing consent: the one-shot CSRF nonce lives
in the running process. It survives hot-reloads, not a restart.

Settings should then show **connected** with your address. If it shows a different address than your
profile, reconnect with the right account — the sweep matches sent mail by sender, so the wrong mailbox
would silently make every sent application look unsent.

### When it goes wrong

| Symptom | Cause |
|---|---|
| `Gmail API has not been used in project <number>` | The API is enabled on a different project than the client. Step 2, right project. |
| `redirect_uri_mismatch` | Rare for Desktop clients. Set `JOBFINDER_REDIRECT=http://localhost:3939/api/gmail/callback` in `.env` and restart. |
| `state mismatch: start from Connect Gmail…` | You reached the callback without starting from Connect, or the server restarted mid-consent. Press Connect again. This is a deliberate CSRF guard. |
| `access_denied` | The app is in Testing and your address is not a test user. Step 5. |
| Connected, then "not connected" a week later | Testing mode: refresh tokens expire after 7 days. Reconnect, or publish (step 5). |
| Draft created but logs `NO CV ATTACHED` | The `cv` path in Settings does not point at a real file. |

**It cannot send.** `gmail.compose` does permit sending, so that is enforced in the code instead: no send
call exists anywhere under `server/`, and `npm test` fails if one is ever added.

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
