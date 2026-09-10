# Job Finder UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost page to browse and rank scraped posts, track the recruiter pipeline, act on rows, run the scraper with parameters, edit settings, and trigger the drafter skill.

**Architecture:** `ui.js` is a single Node file: built-in HTTP server, the installed `pg` driver, and a one-at-a-time child-process job runner for the scraper and the headless Claude drafter. `ui.html` is one plain page with three tabs that talks to the JSON API with `fetch`. `config.json` holds editable scraper defaults that `jobfinder.js` reads.

**Tech Stack:** Node 22 (`node:http`, `node:child_process`), `pg`, plain HTML/CSS/JS, Claude Code CLI (`claude -p`).

**Spec:** `docs/superpowers/specs/2026-09-06-jobfinder-ui-design.md`

## Global Constraints

- No new npm dependencies; no build step; no framework.
- Server binds `127.0.0.1` port `3939` only.
- One child process at a time; a second start returns HTTP 409.
- Headless drafter allow-list: `Read Skill ToolSearch Bash mcp__claude_ai_Gmail__create_draft mcp__claude_ai_Gmail__search_threads mcp__claude_ai_Gmail__get_thread mcp__claude_ai_Gmail__list_drafts`; deny-list: `mcp__claude_ai_Gmail__send_message mcp__claude_ai_Gmail__reply mcp__claude_ai_Gmail__forward mcp__claude_ai_Gmail__trash_message mcp__claude_ai_Gmail__trash_thread`.
- `config.json` fields: `terms` (non-empty string array), `titles` (string array), `max` (integer 1-200), `since` (past-24h | past-week | past-month).
- Not a git repository; no commit steps.

---

## File structure

| File | Responsibility |
|---|---|
| `config.json` | scraper defaults the page can edit |
| `jobfinder.js` | reads `config.json` for defaults (only change) |
| `ui.js` | HTTP server, API, job runner, table bootstrap |
| `ui.html` | the page: Posts, Pipeline, Run & Settings tabs |
| `package.json` | `ui` script |

---

### Task 1: config.json and the scraper reading it

**Files:**
- Create: `config.json`
- Modify: `jobfinder.js` (config section, self-test)
- Modify: `package.json` (script `ui`)

**Interfaces:**
- Produces: `config.json` shape `{terms: string[], titles: string[], max: number, since: string}` consumed by Task 2's `GET/PUT /api/config` and by `jobfinder.js`.

- [ ] **Step 1: Add a self-test assertion that fails**

In `selfTest()` in `jobfinder.js`, after the `systemPrompt` assertion, add:

```js
  if (fs.existsSync('config.json') && !opts.terms) assert.deepEqual(SEARCH_TERMS, JSON.parse(fs.readFileSync('config.json', 'utf8')).terms);
```

- [ ] **Step 2: Create `config.json` from the current constants and run the test to see it fail**

```bash
node -e "
const s=require('fs').readFileSync('jobfinder.js','utf8');
const grab=n=>eval('['+s.split('const '+n+' = ')[1].split('[')[1].split('];')[0]+']');
require('fs').writeFileSync('config.json', JSON.stringify({terms:grab('SEARCH_TERMS'), titles:grab('TARGET_TITLES'), max:40, since:'past-24h'}, null, 2)+'\n');
console.log(JSON.parse(require('fs').readFileSync('config.json')).terms.length, 'terms');
"
npm test
```
Expected: `8 terms`, then the self-test FAILS (`SEARCH_TERMS` still comes from the hard-coded list, which equals the file, so to make it fail meaningfully edit `config.json` first: change the first term to `"zzz"` and expect the deepEqual failure, then change it back).

- [ ] **Step 3: Read the config in `jobfinder.js`**

Directly after the `parseArgs` block, before `const SEARCH_TERMS`, add:

```js
const CONFIG = fs.existsSync('config.json') ? JSON.parse(fs.readFileSync('config.json', 'utf8')) : {}; // edited by ui.js; CLI flags win
```

Then change the four defaults:

```js
const SEARCH_TERMS = opts.terms ? opts.terms.split(',').map(t => t.trim()).filter(Boolean) : CONFIG.terms || [
```
```js
const TARGET_TITLES = CONFIG.titles || [
```
```js
const MAX_CARDS = Number(opts.max) || CONFIG.max || 40;
const SINCE = opts.since || CONFIG.since || 'past-24h';
```

- [ ] **Step 4: Run the test and see it pass, with and without an override**

```bash
npm test
node --env-file-if-exists=.env jobfinder.js --terms "only this" --self-test
```
Expected: `self-test ok` twice.

- [ ] **Step 5: Add the npm script**

```bash
npm pkg set 'scripts.ui=node --env-file-if-exists=.env ui.js'
```

---

### Task 2: ui.js — server, table bootstrap, read endpoints

**Files:**
- Create: `ui.js`

**Interfaces:**
- Produces: `GET /api/posts`, `GET /api/posts/:key`, `GET /api/contacts`, `GET /api/config`, `GET /` (serves `ui.html`, 404 until Task 5). Helpers `send(res, status, obj)`, `readJson(req)`, `db` pool, `DDL`.

- [ ] **Step 1: Write ui.js**

```js
// ui.js — local page over the jobfinder database. Run: npm run ui → http://127.0.0.1:3939
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import pg from 'pg';

const PORT = 3939;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://localhost/jobfinder' });
const SINCE_VALUES = ['past-24h', 'past-week', 'past-month'];
const DRAFT_ALLOW = ['Read', 'Skill', 'ToolSearch', 'Bash', 'mcp__claude_ai_Gmail__create_draft',
  'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__list_drafts'];
const DRAFT_DENY = ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
  'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__trash_thread'];
// Same DDL as the drafter skill, so the pipeline view works before the first drafter run.
const DDL = `
CREATE TABLE IF NOT EXISTS applications (key text PRIMARY KEY REFERENCES posts(key),
  verdict text NOT NULL CHECK (verdict IN ('drafted','skipped')), reason text, recruiter_email text, gmail_draft_id text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS contacts (email text PRIMARY KEY,
  stage text NOT NULL CHECK (stage IN ('drafted','contacted','followed_up','replied','final')),
  thread_id text, last_sent_at timestamptz, note text, updated_at timestamptz NOT NULL DEFAULT now());`;

// ---------------- helpers ----------------
const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readJson = req => new Promise((resolve, reject) => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('body is not JSON')); } }); });
const bad = msg => Object.assign(new Error(msg), { status: 400 });

// ---------------- queries ----------------
const POSTS_SQL = `
SELECT p.key, p.score, p.title, p.company, p.location, p.remote, p.mena, p.emails, p.posted_age, p.scraped_at, p.author,
       a.verdict, a.reason AS verdict_reason, c.stage
FROM posts p LEFT JOIN applications a ON a.key = p.key LEFT JOIN contacts c ON c.email = p.emails[1]
WHERE ($1::int IS NULL OR p.score >= $1) AND ($2::bool IS NOT TRUE OR p.mena) AND ($3::bool IS NOT TRUE OR p.remote)
  AND ($4::bool IS NOT TRUE OR a.key IS NULL)
  AND ($5::text IS NULL OR p.title ILIKE '%' || $5 || '%' OR p.company ILIKE '%' || $5 || '%' OR p.author ILIKE '%' || $5 || '%' OR p.text ILIKE '%' || $5 || '%')
ORDER BY p.score DESC NULLS LAST, p.scraped_at DESC LIMIT 500`;
const CONTACTS_SQL = `
SELECT c.email, c.stage, c.last_sent_at, c.last_sent_at + interval '72 hours' AS due_at, c.note, c.updated_at,
       (SELECT count(*)::int FROM posts p WHERE c.email = ANY(p.emails)) AS post_count
FROM contacts c ORDER BY (c.stage IN ('drafted','followed_up')) DESC, c.last_sent_at NULLS FIRST, c.email`;

// ---------------- config ----------------
function readConfig() { return JSON.parse(fs.readFileSync('config.json', 'utf8')); }
function validateConfig(c) {
  if (!Array.isArray(c.terms) || !c.terms.length || !c.terms.every(t => typeof t === 'string' && t.trim())) throw bad('terms: non-empty list of strings');
  if (!Array.isArray(c.titles) || !c.titles.every(t => typeof t === 'string')) throw bad('titles: list of strings');
  if (!Number.isInteger(c.max) || c.max < 1 || c.max > 200) throw bad('max: integer 1-200');
  if (!SINCE_VALUES.includes(c.since)) throw bad(`since: one of ${SINCE_VALUES.join(', ')}`);
  return { terms: c.terms.map(t => t.trim()), titles: c.titles.map(t => t.trim()).filter(Boolean), max: c.max, since: c.since };
}

// ---------------- job runner: one child at a time ----------------
let job = null; // { kind, args, startedAt, endedAt, exit, log: [], child }
function startJob(kind, args, cmd, cmdArgs) {
  if (job?.child) return null;
  job = { kind, args, startedAt: new Date().toISOString(), endedAt: null, exit: null, log: [], child: null };
  const push = chunk => { job.log.push(...chunk.toString().split('\n').filter(Boolean)); if (job.log.length > 300) job.log.splice(0, job.log.length - 300); };
  const finish = code => { job.exit = code; job.endedAt = new Date().toISOString(); job.child = null; };
  job.log.push(`$ ${cmd} ${cmdArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const child = spawn(cmd, cmdArgs, { cwd: process.cwd(), env: process.env });
  job.child = child;
  child.stdout.on('data', push); child.stderr.on('data', push);
  child.on('error', e => { push(`spawn error: ${e.message}`); finish(-1); });
  child.on('close', code => { if (job.child) finish(code); });
  return job;
}
const jobView = () => job && { kind: job.kind, args: job.args, startedAt: job.startedAt, endedAt: job.endedAt, exit: job.exit, running: !!job.child, log: job.log };
const scrapeArgs = ({ terms, max, since }) => ['--env-file-if-exists=.env', 'jobfinder.js',
  ...(terms ? ['--terms', terms] : []), ...(max ? ['--max', String(max)] : []), ...(since ? ['--since', since] : [])];
const draftPrompt = ({ n, key }) => key
  ? `Use the job-application-drafter skill. Process only the post whose key is ${key}. Report at the end.`
  : `Use the job-application-drafter skill. Process the top ${n || 10} unprocessed posts. Finish with the ranked shortlist.`;
const draftArgs = a => ['-p', draftPrompt(a), '--output-format', 'text', '--allowedTools', ...DRAFT_ALLOW, '--disallowedTools', ...DRAFT_DENY];

// ---------------- routes ----------------
async function route(req, res) {
  const url = new URL(req.url, 'http://x'); const p = url.pathname; const m = req.method;
  const q = k => url.searchParams.get(k);
  if (m === 'GET' && p === '/') return send(res, 200, fs.readFileSync('ui.html', 'utf8'), 'text/html; charset=utf-8');
  if (m === 'GET' && p === '/api/posts') {
    const { rows } = await db.query(POSTS_SQL, [q('min') ? Number(q('min')) : null, q('mena') === '1', q('remote') === '1', q('unprocessed') === '1', q('q') || null]);
    return send(res, 200, rows);
  }
  let mt;
  if (m === 'GET' && (mt = p.match(/^\/api\/posts\/([0-9a-f]{40})$/))) {
    const { rows } = await db.query('SELECT p.*, a.verdict, a.reason AS verdict_reason, c.stage FROM posts p LEFT JOIN applications a ON a.key = p.key LEFT JOIN contacts c ON c.email = p.emails[1] WHERE p.key = $1', [mt[1]]);
    return rows[0] ? send(res, 200, rows[0]) : send(res, 404, { error: 'no such post' });
  }
  if (m === 'POST' && (mt = p.match(/^\/api\/posts\/([0-9a-f]{40})\/skip$/))) {
    const { reason = '' } = await readJson(req);
    const r = await db.query(`INSERT INTO applications (key, verdict, reason, recruiter_email) SELECT key, 'skipped', $2, emails[1] FROM posts WHERE key = $1
      ON CONFLICT (key) DO UPDATE SET verdict = 'skipped', reason = EXCLUDED.reason`, [mt[1], `manual: ${reason}`]);
    return r.rowCount ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such post' });
  }
  if (m === 'GET' && p === '/api/contacts') return send(res, 200, (await db.query(CONTACTS_SQL)).rows);
  if (m === 'POST' && (mt = p.match(/^\/api\/contacts\/([^/]+)\/(final|note)$/))) {
    const email = decodeURIComponent(mt[1]); const { note = '' } = await readJson(req);
    if (mt[2] === 'final') { await db.query(`INSERT INTO contacts (email, stage, note) VALUES ($1, 'final', $2) ON CONFLICT (email) DO UPDATE SET stage = 'final', note = EXCLUDED.note, updated_at = now()`, [email, `manual: ${note}`]); return send(res, 200, { ok: true }); }
    const r = await db.query('UPDATE contacts SET note = $2, updated_at = now() WHERE email = $1', [email, note]);
    return r.rowCount ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such recruiter' });
  }
  if (m === 'GET' && p === '/api/config') return send(res, 200, readConfig());
  if (m === 'PUT' && p === '/api/config') { const c = validateConfig(await readJson(req)); fs.writeFileSync('config.json', JSON.stringify(c, null, 2) + '\n'); return send(res, 200, c); }
  if (m === 'POST' && p === '/api/run/scrape') {
    const a = await readJson(req); if (a.since && !SINCE_VALUES.includes(a.since)) throw bad('since');
    const j = startJob('scrape', a, process.execPath, scrapeArgs(a));
    return j ? send(res, 202, jobView()) : send(res, 409, { error: `busy: ${job.kind} is running` });
  }
  if (m === 'POST' && p === '/api/run/draft') {
    const a = await readJson(req); if (a.key && !/^[0-9a-f]{40}$/.test(a.key)) throw bad('key');
    const j = startJob('draft', a, 'claude', draftArgs(a));
    return j ? send(res, 202, jobView()) : send(res, 409, { error: `busy: ${job.kind} is running` });
  }
  if (m === 'GET' && p === '/api/job') return send(res, 200, jobView());
  if (m === 'POST' && p === '/api/job/stop') { if (job?.child) { job.child.kill('SIGTERM'); return send(res, 200, { ok: true }); } return send(res, 409, { error: 'nothing running' }); }
  send(res, 404, { error: 'no such route' });
}

await db.query(DDL);
http.createServer((req, res) => route(req, res).catch(e => send(res, e.status || 500, { error: e.message })))
  .listen(PORT, '127.0.0.1', () => console.log(`jobfinder ui: http://127.0.0.1:${PORT}`));
```

- [ ] **Step 2: Start it and hit the read endpoints**

```bash
npm run ui &   # leave it running
sleep 2
curl -s 'http://127.0.0.1:3939/api/posts?min=7&mena=1' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.length,'rows; first:',r[0]?.score,r[0]?.title)})"
curl -s http://127.0.0.1:3939/api/contacts
curl -s http://127.0.0.1:3939/api/config | head -c 120
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3939/api/posts/0000000000000000000000000000000000000000
```
Expected: a row count with a score 7+ MENA title; `[]` (no contacts yet); the config JSON; `404`.

---

### Task 3: write endpoints

**Files:**
- Modify: none (all routes are in the Task 2 file); this task is the verification of the write paths.

- [ ] **Step 1: Exercise skip, note-on-unknown, final, config validation**

```bash
K=$(curl -s 'http://127.0.0.1:3939/api/posts?min=0' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).at(-1).key))")
curl -s -X POST http://127.0.0.1:3939/api/posts/$K/skip -H 'content-type: application/json' -d '{"reason":"ui test"}'
curl -s "http://127.0.0.1:3939/api/posts/$K" | grep -o '"verdict":"skipped"'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3939/api/contacts/nobody%40example.com/note -H 'content-type: application/json' -d '{"note":"x"}'
curl -s -X POST http://127.0.0.1:3939/api/contacts/test%40example.com/final -H 'content-type: application/json' -d '{"note":"ui test"}'
curl -s http://127.0.0.1:3939/api/contacts | grep -o '"stage":"final"'
curl -s -o /dev/null -w '%{http_code}\n' -X PUT http://127.0.0.1:3939/api/config -H 'content-type: application/json' -d '{"terms":[],"titles":[],"max":40,"since":"past-24h"}'
curl -s -X PUT http://127.0.0.1:3939/api/config -H 'content-type: application/json' -d "$(cat config.json)" | head -c 60
```
Expected: `{"ok":true}`, `"verdict":"skipped"`, `404`, `{"ok":true}`, `"stage":"final"`, `400`, the config echoed.

- [ ] **Step 2: Remove the test rows**

```bash
/opt/homebrew/opt/postgresql@15/bin/psql -d jobfinder -c "DELETE FROM applications WHERE reason = 'manual: ui test'; DELETE FROM contacts WHERE email = 'test@example.com';"
```
Expected: `DELETE 1` twice.

---

### Task 4: job runner

- [ ] **Step 1: Start a small scrape, confirm 409 while busy, watch the log, stop it**

```bash
curl -s -X POST http://127.0.0.1:3939/api/run/scrape -H 'content-type: application/json' -d '{"terms":"hl7 fhir","max":5}' | head -c 100; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3939/api/run/scrape -H 'content-type: application/json' -d '{}'
sleep 25; curl -s http://127.0.0.1:3939/api/job | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.kind,j.running,j.exit,j.log.slice(-3))})"
```
Expected: `202` body with `"kind":"scrape"`; `409`; after 25 s the log shows `cv:` and `[hl7 fhir] N cards`, then `done:` with `running false, exit 0` (wait longer if still running).

- [ ] **Step 2: Bad inputs**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3939/api/run/draft -H 'content-type: application/json' -d '{"key":"nope"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3939/api/job/stop
```
Expected: `400`, `409` (nothing running).

---

### Task 5: ui.html

**Files:**
- Create: `ui.html`

- [ ] **Step 1: Write the page**

```html
<!doctype html>
<meta charset="utf-8"><title>Job Finder</title>
<style>
:root{--bg:#fff;--fg:#111;--mut:#666;--line:#ddd;--acc:#1a56db;--ok:#127a3a;--warn:#b45309;--bad:#b91c1c;--card:#f7f7f7}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--line:#333;--acc:#7aa2ff;--card:#1b1b1b}}
body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
nav{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid var(--line)}
nav button{background:none;border:1px solid var(--line);color:var(--fg);padding:6px 12px;border-radius:6px;cursor:pointer}
nav button.on{border-color:var(--acc);color:var(--acc)}
main{padding:12px;max-width:1400px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:12px}tr.row{cursor:pointer}tr.row:hover td{background:var(--card)}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
input,select,textarea,button{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 8px}
button.act{border-color:var(--acc);color:var(--acc);cursor:pointer}button:disabled{opacity:.5;cursor:default}
.tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:12px;background:var(--card);margin-right:4px}
.s9{color:var(--ok);font-weight:700}.s6{color:var(--warn);font-weight:600}.mut{color:var(--mut)}
pre{background:var(--card);padding:10px;border-radius:6px;white-space:pre-wrap;max-height:60vh;overflow:auto;font-size:12px}
#banner{display:none;background:var(--bad);color:#fff;padding:8px 12px}
.detail{background:var(--card);padding:10px;border-radius:6px;margin:4px 0 8px}
textarea{width:100%;min-height:90px}label{display:block;margin:8px 0 2px;color:var(--mut);font-size:12px}
</style>
<div id="banner"></div>
<nav><button data-tab="posts" class="on">Posts</button><button data-tab="pipeline">Pipeline</button><button data-tab="run">Run &amp; Settings</button></nav>
<main>
<section id="posts">
  <div class="bar">min score <input id="min" type="number" min="0" max="10" value="6" style="width:60px">
    <label style="display:inline"><input id="mena" type="checkbox"> MENA</label>
    <label style="display:inline"><input id="remote" type="checkbox"> remote</label>
    <label style="display:inline"><input id="unproc" type="checkbox" checked> unprocessed only</label>
    <input id="q" placeholder="search title, company, author, text" style="width:260px">
    <button class="act" id="reload">Reload</button><span id="count" class="mut"></span></div>
  <table><thead><tr><th>score</th><th>title</th><th>company</th><th>location</th><th>flags</th><th>recruiter</th><th>age</th><th>status</th></tr></thead><tbody id="ptab"></tbody></table>
</section>
<section id="pipeline" hidden>
  <h3>To send (drafts waiting in Gmail)</h3><table><thead><tr><th>recruiter</th><th>stage</th><th>posts</th><th>note</th><th></th></tr></thead><tbody id="tosend"></tbody></table>
  <h3>All recruiters</h3><table><thead><tr><th>recruiter</th><th>stage</th><th>last sent</th><th>follow-up due</th><th>posts</th><th>note</th><th></th></tr></thead><tbody id="ctab"></tbody></table>
</section>
<section id="run" hidden>
  <div class="bar"><b>Scrape</b> terms <input id="rterms" style="width:420px"> max <input id="rmax" type="number" style="width:70px">
    since <select id="rsince"><option>past-24h</option><option>past-week</option><option>past-month</option></select>
    <button class="act" id="scrape">Run scrape</button></div>
  <div class="bar"><b>Draft</b> top <input id="dn" type="number" value="5" style="width:60px"> unprocessed posts <button class="act" id="draft">Run drafter</button>
    <button class="act" id="stop">Stop</button><span id="jobstate" class="mut"></span></div>
  <pre id="log">no job yet</pre>
  <h3>Settings (config.json)</h3>
  <label>search terms, one per line</label><textarea id="cterms"></textarea>
  <label>target titles, one per line</label><textarea id="ctitles" style="min-height:160px"></textarea>
  <div class="bar"><label style="display:inline">max cards per term <input id="cmax" type="number" style="width:70px"></label>
    <label style="display:inline">since <select id="csince"><option>past-24h</option><option>past-week</option><option>past-month</option></select></label>
    <button class="act" id="save">Save</button><span id="saved" class="mut"></span></div>
</section>
</main>
<script>
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = d => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }) : '';
async function api(path, opts) {
  const r = await fetch(path, opts && { method: opts.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body || {}) });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) { banner(`${path}: ${j.error}`); throw new Error(j.error); }
  banner(''); return j;
}
function banner(t) { const b = $('#banner'); b.textContent = t; b.style.display = t ? 'block' : 'none'; }
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main section').forEach(s => s.hidden = s.id !== b.dataset.tab);
  ({ posts: loadPosts, pipeline: loadContacts, run: loadRun })[b.dataset.tab]();
});

// ---- posts ----
async function loadPosts() {
  const qs = new URLSearchParams({ min: $('#min').value, mena: +$('#mena').checked, remote: +$('#remote').checked, unprocessed: +$('#unproc').checked, q: $('#q').value });
  const rows = await api('/api/posts?' + qs);
  $('#count').textContent = `${rows.length} posts`;
  $('#ptab').innerHTML = rows.map(r => `<tr class="row" data-key="${r.key}">
    <td class="${r.score >= 8 ? 's9' : r.score >= 6 ? 's6' : ''}">${r.score ?? '-'}</td><td>${esc(r.title)}</td><td>${esc(r.company)}</td><td>${esc(r.location)}</td>
    <td>${r.mena ? '<span class="tag">MENA</span>' : ''}${r.remote ? '<span class="tag">remote</span>' : ''}</td>
    <td>${esc(r.emails?.[0])}${r.stage ? ` <span class="tag">${esc(r.stage)}</span>` : ''}</td><td>${esc(r.posted_age)}</td>
    <td>${r.verdict ? `<span class="tag">${esc(r.verdict)}</span> <span class="mut">${esc(r.verdict_reason)}</span>` : '<span class="mut">new</span>'}</td></tr>`).join('');
  $('#ptab').querySelectorAll('tr.row').forEach(tr => tr.onclick = () => toggleDetail(tr));
}
async function toggleDetail(tr) {
  const next = tr.nextElementSibling; if (next?.classList.contains('detail-row')) return next.remove();
  const p = await api('/api/posts/' + tr.dataset.key);
  const d = document.createElement('tr'); d.className = 'detail-row';
  d.innerHTML = `<td colspan="8"><div class="detail"><p><b>${esc(p.author)}</b> <a href="${esc(p.author_url)}" target="_blank">profile</a> · ${esc(p.location)} · ${esc(p.emails?.join(' '))}</p>
    <p><b>Why:</b> ${esc(p.reason)}</p><pre>${esc(p.text)}</pre>
    <button class="act" data-act="skip">Skip</button> <button class="act" data-act="draft">Draft this one</button></div></td>`;
  tr.after(d);
  d.querySelector('[data-act=skip]').onclick = async () => { const reason = prompt('Reason for skipping?'); if (reason === null) return; await api(`/api/posts/${p.key}/skip`, { body: { reason } }); loadPosts(); };
  d.querySelector('[data-act=draft]').onclick = async () => { await api('/api/run/draft', { body: { key: p.key } }); document.querySelector('nav [data-tab=run]').click(); };
}
$('#reload').onclick = loadPosts; $('#q').onkeydown = e => e.key === 'Enter' && loadPosts();
['#min', '#mena', '#remote', '#unproc'].forEach(s => $(s).onchange = loadPosts);

// ---- pipeline ----
async function loadContacts() {
  const rows = await api('/api/contacts');
  const btns = r => `<button class="act" data-final="${esc(r.email)}">Mark final</button> <button class="act" data-note="${esc(r.email)}">Edit note</button>`;
  $('#tosend').innerHTML = rows.filter(r => ['drafted', 'followed_up'].includes(r.stage)).map(r => `<tr><td>${esc(r.email)}</td><td>${esc(r.stage)}</td><td>${r.post_count}</td><td>${esc(r.note)}</td><td>${btns(r)}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">nothing waiting</td></tr>';
  $('#ctab').innerHTML = rows.map(r => `<tr><td>${esc(r.email)}</td><td><span class="tag">${esc(r.stage)}</span></td><td>${fmt(r.last_sent_at)}</td><td>${r.stage === 'contacted' ? fmt(r.due_at) : ''}</td><td>${r.post_count}</td><td>${esc(r.note)}</td><td>${btns(r)}</td></tr>`).join('') || '<tr><td colspan="7" class="mut">no recruiters yet; run the drafter</td></tr>';
  document.querySelectorAll('[data-final]').forEach(b => b.onclick = async () => { const note = prompt(`Mark ${b.dataset.final} final. Note?`); if (note === null) return; await api(`/api/contacts/${encodeURIComponent(b.dataset.final)}/final`, { body: { note } }); loadContacts(); });
  document.querySelectorAll('[data-note]').forEach(b => b.onclick = async () => { const note = prompt('Note:'); if (note === null) return; await api(`/api/contacts/${encodeURIComponent(b.dataset.note)}/note`, { body: { note } }); loadContacts(); });
}

// ---- run & settings ----
let poll;
async function loadRun() {
  const c = await api('/api/config');
  $('#rterms').value = c.terms.join(', '); $('#rmax').value = c.max; $('#rsince').value = c.since;
  $('#cterms').value = c.terms.join('\n'); $('#ctitles').value = c.titles.join('\n'); $('#cmax').value = c.max; $('#csince').value = c.since;
  showJob(await api('/api/job'));
}
function showJob(j) {
  $('#scrape').disabled = $('#draft').disabled = !!j?.running; $('#stop').disabled = !j?.running;
  $('#jobstate').textContent = j ? `${j.kind} ${j.running ? 'running since ' + fmt(j.startedAt) : `finished ${fmt(j.endedAt)} exit ${j.exit}`}` : '';
  $('#log').textContent = j ? j.log.join('\n') || (j.running ? 'running… (the drafter prints only when it finishes)' : '') : 'no job yet';
  clearInterval(poll); if (j?.running) poll = setInterval(async () => showJob(await api('/api/job')), 2000);
}
$('#scrape').onclick = async () => showJob(await api('/api/run/scrape', { body: { terms: $('#rterms').value, max: Number($('#rmax').value), since: $('#rsince').value } }));
$('#draft').onclick = async () => showJob(await api('/api/run/draft', { body: { n: Number($('#dn').value) } }));
$('#stop').onclick = async () => { await api('/api/job/stop', {}); showJob(await api('/api/job')); };
$('#save').onclick = async () => {
  const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);
  const c = await api('/api/config', { method: 'PUT', body: { terms: lines($('#cterms').value), titles: lines($('#ctitles').value), max: Number($('#cmax').value), since: $('#csince').value } });
  $('#saved').textContent = `saved ${c.terms.length} terms, ${c.titles.length} titles`; loadRun();
};
loadPosts();
</script>
```

- [ ] **Step 2: Open it in Chrome and check each tab with real data**

Open `http://127.0.0.1:3939`. Expected: Posts tab lists posts with score 6+ sorted descending; clicking a row shows the text and two buttons. Pipeline tab shows "no recruiters yet". Run tab shows config prefilled and "no job yet". Save with an empty terms box shows the 400 banner; a valid save shows "saved 8 terms".

---

### Task 6: first real drafter run from the button

- [ ] **Step 1: Run the drafter for one post**

On the Run tab set top = 1 and click Run drafter. Expected: buttons disable, state shows `draft running`, after 2-5 minutes the log shows the skill's report, exit 0. Gmail then holds one new draft; the Posts tab shows that post as `drafted` and the Pipeline tab shows the recruiter at stage `drafted` under "To send".

- [ ] **Step 2: Confirm nothing was sent**

In Gmail, the draft is in Drafts, not Sent. The run's allow-list denies `send_message`, `reply` and `forward`, so a send is impossible from this path.

---

## Self-review against the spec

- API table: every row has a route in Task 2; validation and 404/409/400 paths verified in Tasks 3-4.
- Page: three tabs, filters, detail with Skip and Draft, pipeline "To send" list, run panel with 2 s poll and Stop, settings editor: Task 5.
- Scraper reads config, CLI overrides: Task 1. `npm run ui`: Task 1.
- Tables created at startup: Task 2 (`await db.query(DDL)` before listen).
- Allow/deny lists verbatim from the spec: Task 2 constants.
- Error handling: `route(...).catch` maps thrown errors to 500 or the error's status; banner in the page.
- Testing: curl in Tasks 2-4, Chrome in Task 5, real draft in Task 6.
