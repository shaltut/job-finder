// ui.js — local page over the jobfinder database. Run: npm run ui → http://127.0.0.1:3939
import http from 'node:http';
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import pg from 'pg';
import { basename } from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3939;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://localhost/jobfinder' });
const SINCE_VALUES = ['past-24h', 'past-week', 'past-month'];
// The headless drafter inherits the user-level permission allow list (~/.claude/settings.local.json accumulates
// Bash(curl:*), Bash(rm:*), Bash(echo:*) ... from past approvals) and settings' defaultMode. Deny rules outrank
// allow rules, so the deny list below is what actually keeps the run to psql + Gmail drafting. Verified 2026-09-08:
// psql runs, curl and echo are refused. Never add a sending tool to the allow list; extend the deny list when the
// user-level allow list grows.
const CV_PATH = () => readConfig().cv || '/Users/ahmedshaltoot/Documents/AhmedShaltootCV1.pdf';
const DRAFT_ALLOW = ['Read', 'Skill', 'ToolSearch', 'Bash(/opt/homebrew/opt/postgresql@15/bin/psql:*)', 'mcp__claude_ai_Gmail__create_draft',
  'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__list_drafts', 'mcp__claude_ai_Gmail__get_draft'];
const DRAFT_DENY = [
  'Bash(curl:*)', 'Bash(wget:*)', 'Bash(echo:*)', 'Bash(rm:*)', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(python3:*)', 'Bash(python:*)',
  'Bash(claude:*)', 'Bash(open:*)', 'Bash(osascript:*)', 'Bash(bash)', 'Bash(bash:*)', 'Bash(sh:*)', 'Bash(zsh:*)', 'Bash(cat:*)', 'Bash(killall:*)',
  'Bash(git clone:*)', 'Bash(brew install:*)', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'NotebookEdit',
  'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward', 'mcp__claude_ai_Gmail__update_draft',
  'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_Microsoft_365__outlook_send_mail',
  'mcp__claude_ai_Microsoft_365__outlook_send_draft', 'mcp__claude_ai_Microsoft_365__outlook_forward_mail', 'mcp__claude_ai_Slack__slack_send_message',
  'mcp__claude_ai_Microsoft_365__teams_send_chat_message', 'mcp__claude_ai_Microsoft_365__teams_send_channel_message'];
const DDL = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'); // shared with jobfinder.js

// ---------------- helpers ----------------
const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readJson = req => new Promise((resolve, reject) => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(bad('body is not JSON')); } }); });
const bad = msg => Object.assign(new Error(msg), { status: 400 });

// ---------------- queries ----------------
const POSTS_SQL = `
SELECT p.key, p.score, p.title, p.company, p.location, p.remote, p.mena, p.emails, p.posted_age, p.posted_at, p.scraped_at, p.author, p.flags,
       a.verdict, a.reason AS verdict_reason, c.stage
FROM posts p LEFT JOIN applications a ON a.key = p.key LEFT JOIN contacts c ON c.email = p.emails[1]
WHERE ($1::int IS NULL OR p.score >= $1) AND ($2::bool IS NOT TRUE OR p.mena) AND ($3::bool IS NOT TRUE OR p.remote)
  AND ($4::bool IS NOT TRUE OR a.key IS NULL)
  AND ($5::text IS NULL OR p.title ILIKE '%' || $5 || '%' OR p.company ILIKE '%' || $5 || '%' OR p.author ILIKE '%' || $5 || '%' OR p.text ILIKE '%' || $5 || '%')
  AND ($6::bool IS NOT TRUE OR coalesce(cardinality(p.flags), 0) = 0)
ORDER BY coalesce(cardinality(p.flags), 0) > 0, p.score DESC NULLS LAST, p.posted_at DESC NULLS LAST, p.scraped_at DESC LIMIT 500`;
const STATS_SQL = `
SELECT (SELECT count(*) FROM posts)::int AS posts,
  (SELECT count(*) FROM posts p LEFT JOIN applications a ON a.key = p.key WHERE a.key IS NULL)::int AS unprocessed,
  (SELECT count(*) FROM posts p LEFT JOIN applications a ON a.key = p.key
     WHERE a.key IS NULL AND p.score >= 7 AND coalesce(cardinality(p.flags), 0) = 0 AND (p.mena OR p.remote))::int AS usable,
  (SELECT count(*) FROM contacts WHERE stage IN ('drafted','followed_up'))::int AS drafts_waiting,
  (SELECT count(*) FROM contacts WHERE stage = 'contacted' AND last_sent_at + interval '72 hours' <= now())::int AS followups_due,
  (SELECT count(*) FROM contacts WHERE stage = 'replied')::int AS replied,
  (SELECT max(scraped_at) FROM posts) AS last_scrape`;
const YIELD_SQL = `
SELECT search_term, count(*)::int AS posts, count(*) FILTER (WHERE score >= 7)::int AS s7,
       count(*) FILTER (WHERE score >= 6 AND coalesce(cardinality(flags), 0) = 0 AND (mena OR remote))::int AS usable,
       max(scraped_at) AS last FROM posts GROUP BY 1 ORDER BY usable DESC, s7 DESC, posts DESC`;
const CONTACTS_SQL = `
SELECT c.email, c.stage, c.last_sent_at, c.last_sent_at + interval '72 hours' AS due_at, c.note, c.updated_at,
       (SELECT count(*)::int FROM posts p WHERE c.email = ANY(p.emails)) AS post_count
FROM contacts c ORDER BY (c.stage IN ('drafted','followed_up')) DESC, c.last_sent_at NULLS FIRST, c.email`;

// ---------------- config ----------------
function readConfig() { return JSON.parse(fs.readFileSync('config.json', 'utf8')); }
function validateConfig(c) {
  if (!Array.isArray(c.terms) || !c.terms.length || !c.terms.every(t => typeof t === 'string' && t.trim())) throw bad('terms: non-empty list of strings');
  if (!Array.isArray(c.titles) || !c.titles.some(t => typeof t === 'string' && t.trim()) || !c.titles.every(t => typeof t === 'string')) throw bad('titles: non-empty list of strings');
  if (!Number.isInteger(c.max) || c.max < 1 || c.max > 200) throw bad('max: integer 1-200');
  if (!SINCE_VALUES.includes(c.since)) throw bad(`since: one of ${SINCE_VALUES.join(', ')}`);
  if (c.cv !== undefined && (typeof c.cv !== 'string' || !fs.existsSync(c.cv))) throw bad('cv: path to an existing PDF');
  return { terms: c.terms.map(t => t.trim()), titles: c.titles.map(t => t.trim()).filter(Boolean), max: c.max, since: c.since, ...(c.cv ? { cv: c.cv } : {}) };
}

// ---------------- gmail: attach the CV to drafts (OAuth 2, REST over fetch, no SDK) ----------------
// The MCP draft tool can only take base64 through the model, which corrupts a 75 KB PDF. Here the bytes never
// touch the model: list drafts addressed to known recruiters, rebuild each one with the PDF part, update in place.
const OAUTH_FILE = 'google-oauth.json', TOKEN_FILE = 'gmail-token.json';
// Alternative credential source: gcloud's application-default login with Gmail scopes, kept in an isolated
// CLOUDSDK_CONFIG dir so the work gcloud setup is untouched. Needs a quota project (x-goog-user-project).
const ADC_FILE = process.env.JOBFINDER_ADC || `${process.env.HOME}/.config/gcloud-jobfinder/application_default_credentials.json`;
const SCOPES = 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email';
const REDIRECT = `http://127.0.0.1:${PORT}/api/gmail/callback`;
const oauthClient = () => { if (!fs.existsSync(OAUTH_FILE)) return null; const j = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8')); return j.installed || j.web || null; };
function readToken() {
  if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  if (fs.existsSync(ADC_FILE)) { const a = JSON.parse(fs.readFileSync(ADC_FILE, 'utf8'));
    if (a.refresh_token) return { refresh_token: a.refresh_token, client_id: a.client_id, client_secret: a.client_secret, quota_project_id: a.quota_project_id || null, expires_at: 0, source: 'gcloud' }; }
  return null;
}
const writeToken = t => fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
function gmailStatus() { const t = readToken(); return { configured: !!oauthClient() || fs.existsSync(ADC_FILE), authorized: !!t?.refresh_token, source: t?.source || (t ? 'oauth-client' : null), quotaProject: t?.quota_project_id || null, email: t?.email || null, cv: CV_PATH(), cvExists: fs.existsSync(CV_PATH()) }; }
// The callback is a cross-site GET (Google redirects into it), so the Origin/Sec-Fetch guard cannot cover it:
// without a state nonce any page open in the browser could feed us its own code and point our drafts at its mailbox.
let authState = null;
function authUrl() { const c = oauthClient(); if (!c) throw bad(`${OAUTH_FILE} missing: download the OAuth client JSON from Google Cloud Console into the project folder`);
  const u = new URL(c.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth');
  authState = crypto.randomUUID();
  u.search = new URLSearchParams({ client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', state: authState }); return u.toString(); }
async function tokenRequest(params, t) { const c = t?.client_id ? t : oauthClient();
  const r = await fetch(c.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...params }) });
  const j = await r.json(); if (!r.ok) throw new Error(`oauth: ${j.error_description || j.error}`); return j; }
async function exchangeCode(code) { const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT });
  const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${t.access_token}` } }).then(r => r.json()).catch(() => ({}));
  writeToken({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, email: info.email || null }); }
async function accessToken() { const t = readToken(); if (!t?.refresh_token) throw Object.assign(new Error('gmail not connected'), { status: 409 });
  if (t.expires_at - Date.now() > 60_000) return t;
  const n = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' }, t);
  const fresh = { ...t, access_token: n.access_token, expires_at: Date.now() + n.expires_in * 1000 };
  if (!fresh.email) fresh.email = (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${fresh.access_token}` } }).then(r => r.json()).catch(() => ({}))).email || null;
  writeToken(fresh); return fresh; }
async function gmail(path, init = {}) { const t = await accessToken();
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { ...init, headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', ...(t.quota_project_id ? { 'x-goog-user-project': t.quota_project_id } : {}) } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(`gmail ${path.split('?')[0]}: ${j.error?.message || r.status}`), { status: r.status }); return j; }
const header = (m, n) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
const flatParts = (p, out = []) => { if (p.parts) p.parts.forEach(x => flatParts(x, out)); else out.push(p); return out; };
const decodePart = p => p?.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '';
const b64lines = buf => Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');
const encHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
function buildMime({ to, cc, bcc, replyTo, subject, inReplyTo, references, text, html }, pdfName, pdf) {
  const A = `mixed${Date.now()}`, B = `alt${Date.now()}`;
  const head = [`To: ${to}`, cc && `Cc: ${cc}`, bcc && `Bcc: ${bcc}`, replyTo && `Reply-To: ${replyTo}`, `Subject: ${encHeader(subject)}`, inReplyTo && `In-Reply-To: ${inReplyTo}`, references && `References: ${references}`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${A}"`].filter(Boolean);
  const body = [`--${A}`, `Content-Type: multipart/alternative; boundary="${B}"`, '',
    `--${B}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(text || ''),
    ...(html ? [`--${B}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(html)] : []), `--${B}--`,
    `--${A}`, `Content-Type: application/pdf; name="${pdfName}"`, `Content-Disposition: attachment; filename="${pdfName}"`, 'Content-Transfer-Encoding: base64', '', b64lines(pdf), `--${A}--`, ''];
  return [...head, '', ...body].join('\r\n');
}
// Attach the CV to every Gmail draft addressed to a recruiter who is waiting on one (stage drafted or followed_up)
// and has no PDF yet. Hand-written mail to replied or final recruiters is never touched. Safe to run repeatedly.
async function attachCv() {
  const st = gmailStatus(); if (!st.authorized) return { skipped: 'gmail not connected: open Pipeline and press Connect Gmail, or finish the gcloud login' };
  if (!st.cvExists) return { skipped: `cv not found at ${st.cv}` };
  const pdf = fs.readFileSync(st.cv), name = basename(st.cv);
  const waiting = (await db.query(`SELECT email FROM contacts WHERE stage IN ('drafted','followed_up')`)).rows.map(r => r.email);
  const results = []; let checked = 0;
  for (const email of waiting) for (const d of (await gmail(`drafts?q=${encodeURIComponent('to:' + email)}&maxResults=20`)).drafts || []) {
    checked++;
    const m = (await gmail(`drafts/${d.id}?format=full`)).message;
    const to = header(m, 'To'); const addr = (to.match(/[\w.+-]+@[\w.-]+/) || [''])[0].toLowerCase();
    if (addr !== email) continue;
    const parts = flatParts(m.payload);
    if (parts.some(p => p.mimeType === 'application/pdf')) { results.push({ to: addr, status: 'already attached' }); continue; }
    const raw = buildMime({ to, cc: header(m, 'Cc'), bcc: header(m, 'Bcc'), replyTo: header(m, 'Reply-To'), subject: header(m, 'Subject'), inReplyTo: header(m, 'In-Reply-To'), references: header(m, 'References'),
      text: decodePart(parts.find(p => p.mimeType === 'text/plain')), html: decodePart(parts.find(p => p.mimeType === 'text/html')) }, name, pdf);
    const upd = await gmail(`drafts/${d.id}`, { method: 'PUT', body: JSON.stringify({ message: { raw: Buffer.from(raw).toString('base64url'), threadId: m.threadId } }) });
    const att = flatParts((await gmail(`drafts/${upd.id}?format=full`)).message.payload).find(p => p.filename === name);
    results.push({ to: addr, status: att?.body?.size === pdf.length ? 'attached' : `attached, size ${att?.body?.size} vs ${pdf.length}`, draft: upd.id });
  }
  return { checked, results };
}
const attachSummary = r => r.skipped ? `cv: ${r.skipped}` : `cv: ${r.results.filter(x => x.status === 'attached').length} attached, ${r.results.filter(x => x.status === 'already attached').length} already had it (${r.checked} drafts scanned)`;

// ---------------- daily housekeeping: sync stages, back up the database ----------------
const notify = msg => { if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification ${JSON.stringify(String(msg).slice(0, 200))} with title "Job Finder"`], () => {}); };
const PG_BIN = '/opt/homebrew/opt/postgresql@15/bin';
const STATE_FILE = 'logs/daily.json';
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
function backup() { // dated pg_dump, keep the newest 14
  fs.mkdirSync('backups', { recursive: true });
  const file = `backups/jobfinder-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Cairo' })}.sql`; // local date, not UTC
  execFile(`${PG_BIN}/pg_dump`, ['-d', process.env.DATABASE_URL || 'jobfinder', '-f', file], err => {
    if (err) return console.error(`backup failed: ${err.message}`);
    const old = fs.readdirSync('backups').filter(f => f.startsWith('jobfinder-')).sort().slice(0, -14);
    old.forEach(f => fs.rmSync(`backups/${f}`)); console.log(`backup written: ${file}`);
  });
}
// Hourly check; once a day (while the UI is up and idle) run the Gmail stage sweep so follow-ups fire on time,
// and take a backup. Manual runs are unaffected. The sweep result is pushed as a macOS notification.
async function dailyTick() {
  const st = readState(), now = Date.now(), day = 86400e3;
  if (now - (st.lastBackup || 0) >= day) { backup(); st.lastBackup = now; }
  if (now - (st.lastSync || 0) >= day && gmailStatus().authorized) { if (enqueue('sync', { sync: true, auto: true })) st.lastSync = now; }
  fs.mkdirSync('logs', { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

// ---------------- job runner: two lanes, each sequential, fed by one queue ----------------
// scrape lane: Chrome profile lock, one at a time. draft lane: claude runs (drafts, syncs), one at a time.
// The lanes run concurrently. Single-post draft requests waiting in the queue are batched into one claude session,
// because every session pays 3-5 minutes of setup regardless of how many posts it handles.
const lanes = { scrape: { current: null, last: null }, draft: { current: null, last: null } };
const queue = []; // { id, lane, kind, args, queuedAt }
let seq = 0;
const laneOf = kind => kind === 'scrape' ? 'scrape' : 'draft';
const busy = () => !!(lanes.scrape.current || lanes.draft.current);
function enqueue(kind, args = {}) {
  if (kind === 'draft' && args.key && (queue.some(q => q.args.key === args.key) || lanes.draft.current?.args?.keys?.includes(args.key))) return null;
  if (kind === 'sync' && (queue.some(q => q.kind === 'sync') || lanes.draft.current?.kind === 'sync')) return null;
  const item = { id: ++seq, lane: laneOf(kind), kind, args, queuedAt: new Date().toISOString() };
  queue.push(item); pump(); return item;
}
function pump() {
  for (const lane of Object.keys(lanes)) {
    if (lanes[lane].current) continue;
    const idx = queue.findIndex(q => q.lane === lane); if (idx < 0) continue;
    let item = queue.splice(idx, 1)[0];
    if (item.kind === 'draft' && item.args.key) {
      const more = queue.filter(q => q.kind === 'draft' && q.args.key); more.forEach(q => queue.splice(queue.indexOf(q), 1));
      item = { ...item, args: { keys: [item.args.key, ...more.map(q => q.args.key)] } };
    }
    runJob(lane, item);
  }
}
function runJob(lane, item) {
  const { kind, args } = item;
  const job = { id: item.id, kind, args, startedAt: new Date().toISOString(), endedAt: null, exit: null, log: [], child: null };
  lanes[lane].current = job;
  const [cmd, cmdArgs] = kind === 'scrape' ? [process.execPath, scrapeArgs(args)] : ['claude', draftArgs(args)];
  const push = chunk => { job.log.push(...chunk.toString().split('\n').filter(Boolean)); if (job.log.length > 300) job.log.splice(0, job.log.length - 300); };
  const finish = code => { job.exit = code; job.endedAt = new Date().toISOString(); job.child = null; lanes[lane].current = null; lanes[lane].last = job;
    if (args?.auto) notify(job.log.find(l => !l.startsWith('$ ') && !/^Warning|^attaching|^cv:/.test(l)) || `${kind} finished, exit ${code}`);
    pump(); };
  job.log.push(`$ ${cmd} ${cmdArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const child = spawn(cmd, cmdArgs, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  child.stdout.on('data', push); child.stderr.on('data', push);
  child.on('error', e => { push(`spawn error: ${e.message}`); finish(-1); });
  child.on('close', code => { if (!job.child) return; if (lane === 'scrape') return finish(code);
    push('attaching the CV to new drafts…');
    attachCv().then(r => push(attachSummary(r))).catch(e => push(`attach cv failed: ${e.message}`)).finally(() => finish(code)); });
}
const jobView = j => j && { id: j.id, kind: j.kind, args: j.args, startedAt: j.startedAt, endedAt: j.endedAt, exit: j.exit, running: !!j.child, log: j.log };
const stateView = () => ({ lanes: Object.fromEntries(Object.entries(lanes).map(([l, v]) => [l, { current: jobView(v.current), last: jobView(v.last) }])), queue });
const scrapeArgs = ({ terms, max, since }) => ['--env-file-if-exists=.env', 'jobfinder.js',
  ...(terms ? ['--terms', terms] : []), ...(max ? ['--max', String(max)] : []), ...(since ? ['--since', since] : [])];
const draftPrompt = ({ n, keys, sync }) => sync
  ? 'Use the job-application-drafter skill. Run only the Step 1a stage sweep: check every open recruiter in contacts against Gmail, update stages, draft any follow-up that is due. Do not process new posts. Report every stage change.'
  : keys
    ? `Use the job-application-drafter skill. Process only the posts whose keys are: ${keys.join(', ')}. Treat them as one batch (one email per recruiter). Finish with the ranked shortlist.`
    : `Use the job-application-drafter skill. Process the top ${n || 10} unprocessed posts. Finish with the ranked shortlist.`;
const draftArgs = a => ['-p', draftPrompt(a), '--output-format', 'text', '--permission-mode', 'dontAsk', '--allowedTools', ...DRAFT_ALLOW, '--disallowedTools', ...DRAFT_DENY];

// ---------------- routes ----------------
const LOCAL = /^(127\.0\.0\.1|localhost):3939$/;
async function route(req, res) {
  const url = new URL(req.url, 'http://x'); const p = url.pathname; const m = req.method;
  // Browsers always send Origin / Sec-Fetch-Site on cross-site POSTs; a page open in the browser must not be able to
  // start runs, wipe tokens or change stages. The Host check blocks DNS rebinding. Local processes are unaffected.
  if (!LOCAL.test(req.headers.host || '')) return send(res, 403, { error: 'bad host' });
  const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  if (m !== 'GET' && ((origin && !LOCAL.test(origin.replace(/^https?:\/\//, ''))) || (site && site !== 'same-origin' && site !== 'none'))) return send(res, 403, { error: 'cross-site request refused' });
  const q = k => url.searchParams.get(k);
  if (m === 'GET' && p === '/') return send(res, 200, fs.readFileSync('ui.html', 'utf8'), 'text/html; charset=utf-8');
  if (m === 'GET' && p === '/favicon.ico') return send(res, 204, '', 'image/x-icon');
  if (m === 'GET' && p === '/api/posts') {
    const { rows } = await db.query(POSTS_SQL, [q('min') ? Number(q('min')) : null, q('mena') === '1', q('remote') === '1', q('unprocessed') === '1', q('q') || null, q('unflagged') === '1']);
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
      ON CONFLICT (key) DO UPDATE SET verdict = 'skipped', reason = EXCLUDED.reason WHERE applications.verdict <> 'drafted'`, [mt[1], `manual: ${reason}`]);
    if (r.rowCount) return send(res, 200, { ok: true });
    const exists = (await db.query('SELECT 1 FROM posts WHERE key = $1', [mt[1]])).rowCount;
    return exists ? send(res, 409, { error: 'already drafted; mark the recruiter final instead' }) : send(res, 404, { error: 'no such post' });
  }
  if (m === 'GET' && p === '/api/stats') return send(res, 200, { ...(await db.query(STATS_SQL)).rows[0], running: busy(), queued: queue.length });
  if (m === 'GET' && p === '/api/contacts') return send(res, 200, (await db.query(CONTACTS_SQL)).rows);
  if (m === 'GET' && p === '/api/yield') return send(res, 200, (await db.query(YIELD_SQL)).rows);
  if (m === 'POST' && (mt = p.match(/^\/api\/contacts\/([^/]+)\/(final|note)$/))) {
    const email = decodeURIComponent(mt[1]).toLowerCase(); const { note = '' } = await readJson(req);
    if (mt[2] === 'final') { await db.query(`INSERT INTO contacts (email, stage, note) VALUES ($1, 'final', $2) ON CONFLICT (email) DO UPDATE SET stage = 'final', note = EXCLUDED.note, updated_at = now()`, [email, `manual: ${note}`]); return send(res, 200, { ok: true }); }
    const r = await db.query('UPDATE contacts SET note = $2, updated_at = now() WHERE email = $1', [email, note]);
    return r.rowCount ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such recruiter' });
  }
  if (m === 'GET' && p === '/api/config') return send(res, 200, readConfig());
  if (m === 'PUT' && p === '/api/config') { const body = await readJson(req); const c = validateConfig({ ...body, cv: body.cv ?? readConfig().cv }); fs.writeFileSync('config.json', JSON.stringify(c, null, 2) + '\n'); return send(res, 200, c); }
  if (m === 'POST' && p === '/api/run/scrape') {
    const a = await readJson(req); if (a.since && !SINCE_VALUES.includes(a.since)) throw bad('since');
    enqueue('scrape', a); return send(res, 202, stateView());
  }
  if (m === 'POST' && p === '/api/run/draft') {
    const a = await readJson(req); if (a.key && !/^[0-9a-f]{40}$/.test(a.key)) throw bad('key');
    if (a.n !== undefined && !(Number.isInteger(a.n) && a.n >= 1 && a.n <= 50)) throw bad('n: integer 1-50');
    const item = enqueue('draft', a.key ? { key: a.key } : { n: a.n });
    return send(res, item ? 202 : 200, { ...stateView(), queued: !!item, note: item ? undefined : 'already queued or running' });
  }
  if (m === 'POST' && p === '/api/run/sync') { const item = enqueue('sync', { sync: true }); return send(res, item ? 202 : 200, { ...stateView(), queued: !!item, note: item ? undefined : 'a sync is already queued or running' }); }
  if (m === 'GET' && p === '/api/gmail/status') return send(res, 200, gmailStatus());
  if (m === 'GET' && p === '/api/gmail/auth') { res.writeHead(302, { location: authUrl() }); return res.end(); }
  if (m === 'GET' && p === '/api/gmail/callback') { const code = q('code'); if (!code) throw bad(`google returned: ${q('error') || 'no code'}`);
    if (!authState || q('state') !== authState) throw bad('state mismatch: start from Connect Gmail in the Pipeline tab');
    authState = null; // one shot: a replayed callback fails too
    await exchangeCode(code);
    return send(res, 200, '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>Gmail connected</h2><p>You can close this tab and go back to Job Finder.</p>', 'text/html; charset=utf-8'); }
  if (m === 'POST' && p === '/api/gmail/attach') return send(res, 200, await attachCv());
  if (m === 'POST' && p === '/api/gmail/disconnect') { fs.rmSync(TOKEN_FILE, { force: true }); return send(res, 200, gmailStatus()); }
  if (m === 'GET' && p === '/api/job') return send(res, 200, stateView());
  if (m === 'POST' && p === '/api/job/stop') { const { lane = 'draft' } = await readJson(req); const cur = lanes[lane]?.current;
    if (cur?.child) { cur.child.kill('SIGTERM'); return send(res, 200, { ok: true }); } return send(res, 409, { error: `nothing running in the ${lane} lane` }); }
  if (m === 'POST' && (mt = p.match(/^\/api\/queue\/(\d+)\/cancel$/))) { const i = queue.findIndex(q => q.id === Number(mt[1])); if (i < 0) return send(res, 404, { error: 'not queued' }); queue.splice(i, 1); return send(res, 200, stateView()); }
  send(res, 404, { error: 'no such route' });
}

if (process.argv[2] === '--self-test') { // the MIME builder is the only logic here worth a check without Gmail
  const pdf = Buffer.from('%PDF-1.4 fake ' + 'x'.repeat(200)); const mime = buildMime({ to: 'a@b.com', subject: 'Rôle — Ahmed', inReplyTo: '<m1@x>', text: 'hello & bye', html: '<p>hello &amp; bye</p>' }, 'cv.pdf', pdf);
  const [, boundary] = mime.match(/multipart\/mixed; boundary="([^"]+)"/); const parts = mime.split(`--${boundary}`);
  assert.equal(parts.length, 4); assert.match(mime, /^Subject: =\?UTF-8\?B\?/m); assert.match(mime, /^In-Reply-To: <m1@x>/m);
  const pdfPart = parts[2]; assert.match(pdfPart, /filename="cv.pdf"/); assert.deepEqual(Buffer.from(pdfPart.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64'), pdf);
  assert.equal(Buffer.from(parts[1].split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString(), 'hello & bye');
  assert.throws(() => validateConfig({ terms: ['a'], titles: [], max: 5, since: 'past-24h' }), /titles/);
  if (fs.existsSync(OAUTH_FILE)) { const s1 = new URL(authUrl()).searchParams.get('state'), s2 = new URL(authUrl()).searchParams.get('state');
    assert.ok(s1 && s1 !== s2 && s2 === authState); } // every Connect Gmail press mints a fresh state, and it is the one the callback checks
  assert.ok(gmailStatus().cv.endsWith('.pdf') && typeof attachSummary({ skipped: 'x' }) === 'string'); // touches CV_PATH and the attach helpers
  assert.equal(validateConfig({ terms: ['a'], titles: ['t'], max: 5, since: 'past-24h' }).cv, undefined);
  assert.match(buildMime({ to: 'a@b.com', bcc: 'me@x.com', replyTo: 'r@x.com', subject: 's', text: 't' }, 'cv.pdf', Buffer.from('x')), /^Bcc: me@x\.com\r\nReply-To: r@x\.com/m);
  console.log('ui self-test ok'); process.exit(0);
}
// Postgres has been found stopped twice; try to start the Homebrew service once before giving up.
try { await db.query(DDL); } catch (e) {
  console.error(`database not ready: ${e.message}; trying brew services start postgresql@15`);
  await new Promise(r => execFile('/opt/homebrew/bin/brew', ['services', 'start', 'postgresql@15'], () => r()));
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) { await new Promise(r => setTimeout(r, 1000)); try { await db.query(DDL); ok = true; } catch {} }
  if (!ok) { console.error('database still not ready; giving up'); process.exit(1); }
  console.error('database is up');
}
setInterval(dailyTick, 3600e3); setTimeout(dailyTick, 30e3);
http.createServer((req, res) => route(req, res).catch(e => send(res, e.status || 500, { error: e.message })))
  .listen(PORT, '127.0.0.1', () => console.log(`jobfinder ui: http://127.0.0.1:${PORT}`));
