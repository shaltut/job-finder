# LinkedIn Feed Job-Post Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Node script that, once a day via launchd, searches LinkedIn feed posts for 8 role keywords, keeps the past-24h posts that contain a contact email, scores them with OpenAI, and appends them to `jobs.csv`.

**Architecture:** One file, `jobfinder.js`, with a config block, pure helpers, a Playwright scraper that drives the installed Chrome from its own persistent profile, and an OpenAI structured-output scorer. `jobs.csv` is both output and dedupe store. launchd runs it at 08:00.

**Tech Stack:** Node 22 (ESM, `--env-file-if-exists`), `playwright-core` with `channel: 'chrome'`, `openai` (Responses API, `gpt-5-nano`), macOS launchd.

**Spec:** `docs/superpowers/specs/2026-09-06-linkedin-job-finder-design.md`

## Global Constraints

- Node 22.12 and Google Chrome are already installed; no browser download (`playwright-core`, not `playwright`).
- Only two npm dependencies: `playwright-core`, `openai`. No dotenv, no CSV library.
- The project is not a git repository by the user's choice; there are no commit steps.
- Never put the OpenAI key in code. It lives in `.env`, which the user writes by hand.
- Headed Chrome (`headless: false`), separate profile dir `./profile`.
- Search URL: `https://www.linkedin.com/search/results/content/?keywords=<term>&datePosted=%5B%22past-24h%22%5D` (no `contentType` filter).
- CSV columns, in order: `key, scraped_at, search_term, author, author_url, posted_age, title, company, location, remote, mena, emails, score, reason, text`.
- Exit code 2 means the LinkedIn login expired.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json` | deps and the four run scripts |
| `.gitignore` | keeps `profile/`, `logs/`, `.env`, `node_modules/` out of any future repo |
| `.env` | `OPENAI_API_KEY=...` (user-written) |
| `jobfinder.js` | everything: config, helpers, browser, scraper, scorer, CLI dispatch |
| `com.jobfinder.plist` | launchd job definition, installed by copying into `~/Library/LaunchAgents` |
| `jobs.csv` | output + dedupe store (created on first real run) |
| `logs/` | launchd stdout/stderr |

---

### Task 1: Scaffold, pure helpers, self-test

**Files:**
- Create: `package.json`, `.gitignore`, `jobfinder.js`

**Interfaces:**
- Produces: `extractEmails(text, mailtos=[]) -> string[]` (lowercased, unique), `dedupeKey(authorUrl, text) -> 40-hex string`, `csvEscape(value) -> string`, `readKeys(csvText) -> Set<string>`, `appendRows(rows: object[])`, constants `SEARCH_TERMS`, `TARGET_TITLES`, `MENA`, `MODEL`, `MAX_CARDS`, `CSV_PATH`, `PROFILE_DIR`, `COLUMNS`, helpers `sleep(ms)`, `rand(a,b)`, `searchUrl(term)`.

- [ ] **Step 1: Init the package and install the two dependencies**

Run, from the project directory:
```bash
npm init -y >/dev/null && npm pkg set type=module \
  scripts.start="node --env-file-if-exists=.env jobfinder.js" \
  scripts.login="node --env-file-if-exists=.env jobfinder.js --login" \
  scripts.dry="node --env-file-if-exists=.env jobfinder.js --dry-run" \
  scripts.test="node --env-file-if-exists=.env jobfinder.js --self-test" \
  && npm i playwright-core openai
printf 'node_modules/\nprofile/\nlogs/\n.env\n' > .gitignore
```
Expected: `package.json` lists both deps under `dependencies`, `"type": "module"` is set.

- [ ] **Step 2: Write `jobfinder.js` with the config block, the self-test, and NO helpers yet**

```js
// jobfinder.js — daily LinkedIn feed job-post finder.
// Usage: npm start | npm run login | npm run dry | npm test
import { chromium } from 'playwright-core';
import OpenAI from 'openai';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// ---------------- config ----------------
const SEARCH_TERMS = [
  'engineering manager', 'head of engineering', '.net team lead', 'senior .net developer',
  'solution architect', 'hl7 fhir', 'health insurance technology', 'ai engineering manager',
];
const TARGET_TITLES = [
  'Director of Engineering', 'Head of Engineering', 'Engineering Manager', 'VP of Engineering',
  'CTO', 'Co-founder & CTO', 'Technical Director', 'Head of Platform Engineering',
  'Senior .NET Developer', 'Senior Backend Engineer (.NET)', '.NET Team Lead', 'Technical Team Lead',
  'Lead Software Engineer', 'Principal Engineer', 'Staff Engineer', 'Solution Architect',
  'Software Architect', 'Technical Architect', 'Senior Full Stack Developer (.NET + Angular/React)',
  'Healthcare Integration Engineer', 'HL7-FHIR Integration Architect', 'Claims Platform Engineering Manager',
  'Head of Claims Technology', 'Digital Health Solutions Architect', 'Payer Technology Lead',
  'Health Insurtech Engineering Lead', 'Product Engineering Lead — Health Insurance / RCM',
  'AI Engineering Manager', 'Head of AI Engineering', 'AI Solutions Architect — Healthcare',
];
const MENA = 'UAE, Saudi Arabia, Egypt, Qatar, Kuwait, Bahrain, Oman, Jordan, Lebanon, Iraq, Morocco, Tunisia, Algeria '
  + '(cities: Dubai, Abu Dhabi, Riyadh, Jeddah, Cairo, Doha, Kuwait City, Manama, Muscat, Amman)';
const MODEL = 'gpt-5-nano';
const MAX_CARDS = 60;
const CSV_PATH = 'jobs.csv';
const PROFILE_DIR = 'profile';
const COLUMNS = ['key', 'scraped_at', 'search_term', 'author', 'author_url', 'posted_age', 'title', 'company',
  'location', 'remote', 'mena', 'emails', 'score', 'reason', 'text'];

// ---------------- CLI (keep this block at the very end of the file: the consts above must be initialised before it runs) ----------------
const arg = process.argv[2];
try {
  if (arg === '--self-test') selfTest();
  else throw new Error(`unknown arg ${arg}`);
} catch (e) { console.error(e.message); process.exit(e.code || 1); }

function selfTest() {
  assert.deepEqual(extractEmails('Send CV to HR@Acme.sa or jobs@x.co.uk today', ['hr@acme.sa']), ['hr@acme.sa', 'jobs@x.co.uk']);
  assert.deepEqual(extractEmails('no contact here'), []);
  const k1 = dedupeKey('https://www.linkedin.com/in/a', 'x'.repeat(200));
  assert.equal(k1, dedupeKey('https://www.linkedin.com/in/a', 'x'.repeat(120) + 'different tail'));
  assert.notEqual(k1, dedupeKey('https://www.linkedin.com/in/b', 'x'.repeat(200)));
  assert.match(k1, /^[0-9a-f]{40}$/);
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvEscape(undefined), '');
  const k2 = 'b'.repeat(40);
  assert.deepEqual([...readKeys(`${COLUMNS.join(',')}\n${k1},2026-09-06,"multi\nline"\n${k2},x`)], [k1, k2]);
  assert.match(searchUrl('.net team lead'), /keywords=\.net%20team%20lead&datePosted=%5B%22past-24h%22%5D$/);
  console.log('self-test ok');
}
```

- [ ] **Step 3: Run the self-test and watch it fail**

Run: `npm test`
Expected: `extractEmails is not defined` (exit code 1).

- [ ] **Step 4: Add the helpers directly under the config block**

Insert this block between the config section and the CLI block:

```js
// ---------------- pure helpers ----------------
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const extractEmails = (text, mailtos = []) =>
  [...new Set([...mailtos, ...(text.match(EMAIL_RE) || [])].map(e => e.toLowerCase()))];
const dedupeKey = (authorUrl, text) => createHash('sha1').update(authorUrl + text.slice(0, 120)).digest('hex');
const csvEscape = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// key is the first column, so every data row starts with 40 hex chars + comma; continuation lines of a
// multi-line text field never do. One regex reads the whole store.
const readKeys = csv => new Set(csv.match(/^[0-9a-f]{40}(?=,)/gm) || []);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const searchUrl = term =>
  `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(term)}&datePosted=%5B%22past-24h%22%5D`;

function appendRows(rows) {
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, COLUMNS.join(',') + '\n');
  fs.appendFileSync(CSV_PATH, rows.map(r => COLUMNS.map(c => csvEscape(r[c])).join(',') + '\n').join(''));
}
```

- [ ] **Step 5: Run the self-test and watch it pass**

Run: `npm test`
Expected: `self-test ok`, exit 0.

---

### Task 2: Browser with persistent profile, `--login`

**Files:**
- Modify: `jobfinder.js` (add browser section, extend CLI dispatch)

**Interfaces:**
- Consumes: `PROFILE_DIR` from Task 1.
- Produces: `openBrowser() -> Promise<BrowserContext>` (headed real Chrome, profile at `./profile`), `login() -> Promise<void>`.

- [ ] **Step 1: Add the browser section after the helpers and before the CLI block**

```js
// ---------------- browser ----------------
// Real Chrome from its own profile dir. Chrome refuses automation on the user's main profile,
// so this one is logged into once via --login and reused forever after.
const openBrowser = () => chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: null, args: ['--window-size=1400,1000'],
});

async function login() {
  const ctx = await openBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.linkedin.com/login');
  console.log('Log in inside the Chrome window (tick "Keep me signed in"). Waiting up to 5 minutes...');
  await page.waitForURL(/linkedin\.com\/feed/, { timeout: 300_000 });
  console.log(`Logged in. Session saved in ./${PROFILE_DIR}`);
  await ctx.close();
}
```

- [ ] **Step 2: Extend the CLI dispatch**

Replace the `try { ... }` block in the CLI section with:

```js
try {
  if (arg === '--self-test') selfTest();
  else if (arg === '--login') await login();
  else throw new Error(`unknown arg ${arg}`);
} catch (e) { console.error(e.message); process.exit(e.code || 1); }
```

- [ ] **Step 3: Log in once (the user does this, not the agent)**

Run: `npm run login`
Expected: a Chrome window opens on the LinkedIn login page. The user signs in. The terminal prints `Logged in. Session saved in ./profile` and the window closes. If LinkedIn asks for an email verification code, the user completes it in the same window.

- [ ] **Step 4: Verify the session persists**

Run: `npm run login` again.
Expected: Chrome opens, LinkedIn redirects straight to the feed, the script prints `Logged in.` within a few seconds without any typing. Then `npm test` still prints `self-test ok`.

---

### Task 3: Scrape one search term, `--dry-run`

**Files:**
- Modify: `jobfinder.js` (add scraping section, extend CLI dispatch with `run`)

**Interfaces:**
- Consumes: `openBrowser`, `searchUrl`, `sleep`, `rand`, `MAX_CARDS`, `extractEmails`, `dedupeKey`, `SEARCH_TERMS`.
- Produces: `readCards()` (runs inside the page, returns `{author, authorUrl, age, text, mailtos}[]`), `scrapeTerm(page, term) -> Promise<Card[]>` (throws `Error` with `code = 2` on login redirect), `run({ dry }) -> Promise<void>`.

- [ ] **Step 1: Add the scraping section after the browser section and before the CLI block**

```js
// ---------------- scraping ----------------
// Runs inside the page. LinkedIn's class names are hashed and there is no post URN in the DOM,
// so cards are found structurally: the container whose children each hold an author link.
function readCards() {
  const main = document.querySelector('main');
  if (!main) return [];
  const lists = [...main.querySelectorAll('div')]
    .map(e => ({ e, n: [...e.children].filter(c => c.querySelector('a[href*="/in/"],a[href*="/company/"]')).length }))
    .filter(x => x.n >= 2).sort((a, b) => b.n - a.n);
  const list = lists[0]?.e;
  if (!list) return [];
  return [...list.children].flatMap(card => {
    const a = card.querySelector('a[href*="/in/"],a[href*="/company/"]');
    if (!a) return [];
    return [{
      author: a.innerText.trim().split('\n')[0],
      authorUrl: a.href.split('?')[0],
      age: (card.innerText.match(/\b\d+\s?(h|d|w|mo)\b/) || [''])[0],
      text: card.innerText.slice(0, 3000),
      mailtos: [...card.querySelectorAll('a[href^="mailto:"]')].map(m => m.href.slice(7).split('?')[0]),
    }];
  });
}

async function scrapeTerm(page, term) {
  await page.goto(searchUrl(term), { waitUntil: 'domcontentloaded' });
  await sleep(rand(3000, 5000));
  if (/\/(login|authwall|checkpoint)/.test(page.url())) throw Object.assign(new Error('login expired'), { code: 2 });
  await page.mouse.move(500, 400); // over the results column; <main> is the scroll container
  let last = -1, stable = 0, cards = [];
  while (stable < 4 && cards.length < MAX_CARDS) {
    await page.mouse.wheel(0, 4000);
    await sleep(rand(2000, 5000));
    cards = await page.evaluate(readCards);
    stable = cards.length === last ? stable + 1 : 0;
    last = cards.length;
  }
  // reverse order: each click removes a button, so a forward loop over index locators skips every other one
  const more = await page.locator('main button', { hasText: /…\s*more$/ }).all();
  for (const b of more.reverse()) await b.click({ timeout: 2000 }).catch(() => {});
  await sleep(1000);
  return (await page.evaluate(readCards)).slice(0, MAX_CARDS);
}

async function run({ dry }) {
  const ctx = await openBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    for (const term of dry ? SEARCH_TERMS.slice(0, 1) : SEARCH_TERMS) {
      let cards;
      try { cards = await scrapeTerm(page, term); }
      catch (e) { if (e.code === 2) throw e; console.error(`[${term}] failed: ${e.message}`); continue; }
      console.log(`[${term}] ${cards.length} cards`);
      for (const c of cards) {
        const emails = extractEmails(c.text, c.mailtos);
        const key = dedupeKey(c.authorUrl, c.text);
        if (dry) { console.log(`- ${key.slice(0, 8)} | ${c.author} | ${c.age} | ${emails.join(' ') || '-'} | ${c.text.replace(/\s+/g, ' ').slice(0, 100)}`); continue; }
      }
      if (!dry) await sleep(rand(10000, 20000));
    }
  } finally { await ctx.close(); }
}
```

- [ ] **Step 2: Extend the CLI dispatch**

```js
try {
  if (arg === '--self-test') selfTest();
  else if (arg === '--login') await login();
  else await run({ dry: arg === '--dry-run' });
} catch (e) { console.error(e.message); process.exit(e.code || 1); }
```

- [ ] **Step 3: Dry-run against the live site**

Run: `npm run dry`
Expected: Chrome opens on the "engineering manager" past-24h search, scrolls for 10 to 30 seconds, then the terminal prints `[engineering manager] N cards` with N between 5 and 60, followed by one line per card. At least one line shows an email in the fourth column (the spike found 3 of 14). Exit 0.

- [ ] **Step 4: Verify the login guard**

A logged-in profile redirects `/login` to `/feed`, so test with a fresh, logged-out profile instead: temporarily set `PROFILE_DIR = 'profile-empty'`, run `npm run dry`, expect `login expired` and exit code 2 (`echo $?`). Revert `PROFILE_DIR` and `rm -rf profile-empty`. Run `npm test` to confirm `self-test ok`.

---

### Task 4: OpenAI scoring and CSV writing, full run

**Files:**
- Modify: `jobfinder.js` (add scoring section, complete the `run` loop)

**Interfaces:**
- Consumes: `MODEL`, `TARGET_TITLES`, `MENA`, `appendRows`, `readKeys`, `CSV_PATH`, `COLUMNS`, everything from Task 3.
- Produces: `scorePost(text) -> Promise<{title, company, location, is_remote, is_mena, score, reason}>`.

- [ ] **Step 1: User creates `.env`**

The user writes `.env` in the project directory containing `OPENAI_API_KEY=<their key>`. The agent never touches this file.

- [ ] **Step 2: Add the scoring section after the scraping section and before the CLI block**

```js
// ---------------- scoring ----------------
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'company', 'location', 'is_remote', 'is_mena', 'score', 'reason'],
  properties: {
    title: { type: 'string' }, company: { type: 'string' }, location: { type: 'string' },
    is_remote: { type: 'boolean' }, is_mena: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 10 }, reason: { type: 'string' },
  },
};
const SYSTEM = `You screen LinkedIn job posts for one candidate. Extract fields from the post text and score fit 0-10.
Candidate target titles: ${TARGET_TITLES.join('; ')}.
Candidate accepts remote roles anywhere, or on-site/hybrid roles in MENA (${MENA}).
is_remote: true only if the post says remote or work from home.
is_mena: true if the location, the company, or the contact email domain (.sa .ae .eg .qa .kw .om .bh .jo .lb .iq .ma .tn .dz) points to MENA.
score: 9-10 title matches a target and location fits; 6-8 close title or location fits; 3-5 related engineering role but location or seniority off; 0-2 unrelated.
Use "unknown" for strings you cannot find. reason: one sentence.`;
let openai;
async function scorePost(text) {
  openai ??= new OpenAI();
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
    text: { format: { type: 'json_schema', name: 'job_post', strict: true, schema: SCHEMA } },
  });
  return JSON.parse(r.output_text);
}
```

- [ ] **Step 3: Complete the `run` loop**

Replace the whole `run` function with:

```js
async function run({ dry }) {
  const seen = fs.existsSync(CSV_PATH) ? readKeys(fs.readFileSync(CSV_PATH, 'utf8')) : new Set();
  const ctx = await openBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  let added = 0;
  try {
    for (const term of dry ? SEARCH_TERMS.slice(0, 1) : SEARCH_TERMS) {
      let cards;
      try { cards = await scrapeTerm(page, term); }
      catch (e) { if (e.code === 2) throw e; console.error(`[${term}] failed: ${e.message}`); continue; }
      console.log(`[${term}] ${cards.length} cards`);
      for (const c of cards) {
        const emails = extractEmails(c.text, c.mailtos);
        const key = dedupeKey(c.authorUrl, c.text);
        if (dry) { console.log(`- ${key.slice(0, 8)} | ${c.author} | ${c.age} | ${emails.join(' ') || '-'} | ${c.text.replace(/\s+/g, ' ').slice(0, 100)}`); continue; }
        if (!emails.length || seen.has(key)) continue;
        seen.add(key);
        let s = {};
        try { s = await scorePost(c.text); }
        catch (e) { s = { reason: 'score_failed' }; console.error(`score failed for ${c.author}: ${e.message}`); }
        appendRows([{
          key, scraped_at: new Date().toISOString(), search_term: term, author: c.author, author_url: c.authorUrl,
          posted_age: c.age, title: s.title, company: s.company, location: s.location, remote: s.is_remote,
          mena: s.is_mena, emails: emails.join(' '), score: s.score, reason: s.reason, text: c.text,
        }]);
        added++;
      }
      if (!dry) await sleep(rand(10000, 20000));
    }
  } finally { await ctx.close(); }
  console.log(`done: ${added} new rows in ${CSV_PATH}`);
}
```

- [ ] **Step 4: Full run**

Run: `npm start`
Expected: Chrome works through all 8 terms (roughly 3 to 6 minutes), the terminal prints one `[term] N cards` line per term and ends with `done: K new rows in jobs.csv` with K > 0. `head -c 600 jobs.csv` shows the header line and a first row starting with a 40-hex key. Scores are integers 0 to 10; a Saudi or Egyptian email domain shows `mena` = `true`.

- [ ] **Step 5: Dedupe check**

Run: `wc -l jobs.csv && npm start && wc -l jobs.csv`
Expected: the second run prints `done: 0 new rows` (or a small number if new posts appeared in between) and the line count grows by at most that number.

- [ ] **Step 6: Self-test still passes**

Run: `npm test`
Expected: `self-test ok`.

---

### Task 5: launchd schedule

**Files:**
- Create: `com.jobfinder.plist`, `logs/`

**Interfaces:**
- Consumes: `npm start` equivalent command from Task 1.

- [ ] **Step 1: Write the plist template**

Create `com.jobfinder.plist` (the `NODE_PATH` and `PROJECT_DIR` tokens are substituted in Step 2):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jobfinder</string>
  <key>ProgramArguments</key>
  <array>
    <string>NODE_PATH</string>
    <string>--env-file-if-exists=.env</string>
    <string>jobfinder.js</string>
  </array>
  <key>WorkingDirectory</key><string>PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>PROJECT_DIR/logs/out.log</string>
  <key>StandardErrorPath</key><string>PROJECT_DIR/logs/err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Install it with real paths**

Run, from the project directory:
```bash
mkdir -p logs
sed -e "s#NODE_PATH#$(which node)#g" -e "s#PROJECT_DIR#$PWD#g" com.jobfinder.plist > ~/Library/LaunchAgents/com.jobfinder.plist
launchctl unload ~/Library/LaunchAgents/com.jobfinder.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.jobfinder.plist
launchctl list | grep jobfinder
```
Expected: `plutil -lint ~/Library/LaunchAgents/com.jobfinder.plist` says OK and the grep prints a line containing `com.jobfinder`.

If `launchctl load` prints `Load failed: 5: Input/output error` (legacy verbs on recent macOS), use the modern forms instead:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jobfinder.plist
launchctl print gui/$(id -u)/com.jobfinder | head -3
```

- [ ] **Step 3: Trigger a run through launchd now**

Run: `launchctl start com.jobfinder` (or `launchctl kickstart -k gui/$(id -u)/com.jobfinder`), wait for the Chrome window to finish (a few minutes), then `tail -n 3 logs/out.log logs/err.log`.
Expected: `out.log` ends with `done: K new rows in jobs.csv`; `err.log` is empty or contains only per-post `score failed` lines.

- [ ] **Step 4: Record the kill switch**

Confirm this stops the schedule: `launchctl unload ~/Library/LaunchAgents/com.jobfinder.plist` (modern: `launchctl bootout gui/$(id -u)/com.jobfinder`). Re-enable with `load` / `bootstrap`. Add whichever pair worked as a comment at the top of `jobfinder.js`.

---

## Self-review against the spec

- Runtime, profile, headed Chrome, `--login`: Task 2.
- 8 terms, past-24h, no contentType filter: Task 1 config + Task 3 `searchUrl`.
- Email pre-filter, one OpenAI call per survivor, structured output: Task 4.
- Text only, image posts skipped: nothing reads images; a card with no email text is dropped.
- Dedupe key and `jobs.csv` as store, key first column: Task 1 helpers, Task 4 loop.
- Scroll until stable for 3 rounds or 60 cards, expand "… more": Task 3.
- Login redirect exit 2, per-term failure continues, score failure still writes the row: Tasks 3 and 4.
- launchd 08:00, logs, kill switch: Task 5.
- `--dry-run`, `--login`, `--self-test`: Tasks 3, 2, 1.
