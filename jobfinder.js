// jobfinder.js — daily LinkedIn feed job-post finder.
// Usage: npm start [-- --terms "a,b" --max 40 --since past-week --cv my.pdf] | npm start -- --rescore | npm run dry | npm run login | npm test
// Manual by default. Daily 08:00 schedule (with 0-30 min jitter): npm run schedule | npm run unschedule
// Store: Postgres table "posts" (DATABASE_URL, default postgres://localhost/jobfinder).
import { chromium } from 'playwright-core';
import OpenAI from 'openai';
import pg from 'pg';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// ---------------- config ----------------
const { values: opts } = parseArgs({ options: {
  terms: { type: 'string', short: 't' },   // comma-separated search terms, overrides the list below
  max: { type: 'string', short: 'm' },     // cards per term (default 40)
  since: { type: 'string', short: 's' },   // LinkedIn date filter: past-24h (default) | past-week | past-month
  cv: { type: 'string' },                  // path to the CV PDF the posts are scored against
  rescore: { type: 'boolean' },            // rescore every stored post with the current CV and prompt
  reflag: { type: 'boolean' },             // recompute the pre-screen flags for every stored post (no API)
  'dry-run': { type: 'boolean' }, login: { type: 'boolean' }, 'self-test': { type: 'boolean' },
  jitter: { type: 'boolean' },             // scheduled runs: wait 0-30 min before starting
} });
const CONFIG = fs.existsSync('config.json') ? JSON.parse(fs.readFileSync('config.json', 'utf8')) : {}; // edited by ui.js; CLI flags win
const SEARCH_TERMS = opts.terms ? opts.terms.split(',').map(t => t.trim()).filter(Boolean) : CONFIG.terms || [
  'engineering manager', 'head of engineering', '.net team lead', 'senior .net developer',
  'solution architect', 'hl7 fhir', 'health insurance technology', 'ai engineering manager',
];
const TARGET_TITLES = CONFIG.titles?.length ? CONFIG.titles : [
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
const CV_PATH = opts.cv || CONFIG.cv || '/Users/ahmedshaltoot/Documents/AhmedShaltootCV1.pdf';
const MAX_CARDS = Number(opts.max) || CONFIG.max || 40;
const SINCE = opts.since || CONFIG.since || 'past-24h';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/jobfinder'; // Homebrew Postgres, local trust auth
const PROFILE_DIR = process.env.PROFILE_DIR || 'profile';

// ---------------- pure helpers ----------------
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
// LinkedIn innerText glues sentences: 'hr@acme.com.Apply now' -> drop a capitalised word riding on the domain
const trimLabel = e => e.replace(/\.([A-Z][a-z]+)$/, '');
const extractEmails = (text, mailtos = []) =>
  [...new Set([...mailtos, ...(text.match(EMAIL_RE) || []).map(trimLabel)].map(e => e.toLowerCase()))];
// Card text starts with a header that drifts between runs ("5h" -> "1d", Follow -> Following, Edited),
// so strip those markers and collapse whitespace before hashing.
const keyText = t => t.replace(/\b\d+\s?(mo|m|h|d|w)\b|\bEdited\b|\bFollow(ing)?\b|• (1st|2nd|3rd\+)/g, '').replace(/\s+/g, ' ').slice(0, 160);
// ponytail: the 160 chars still include the author's headline, so a headline edit re-keys their posts; strip it if that bites
const dedupeKey = (authorUrl, text) => createHash('sha1').update(authorUrl + keyText(text)).digest('hex');
// LinkedIn renders part of the home feed in the account's language (Arabic here) whatever locale Chrome asks for,
// which blanks the age and drifts the dedupe key. Fold the Arabic age back into its English form: '٣ من الساعات' -> '3h'.
const AR_UNIT = { 'ثانية': 'm', 'الثواني': 'm', 'دقيقة': 'm', 'الدقائق': 'm', 'ساعة': 'h', 'الساعات': 'h',
  'يوم': 'd', 'الأيام': 'd', 'أسبوع': 'w', 'الأسابيع': 'w', 'شهر': 'mo', 'الشهور': 'mo' };
const MARKS = '[\\s\u200e\u200f\u061c\u2066-\u2069]*'; // RTL/isolate marks sit between the digits and the unit
const AR_AGE = new RegExp(`(\\d+)${MARKS}(?:\u0645\u0646${MARKS})?(${Object.keys(AR_UNIT).join('|')})`, 'g');
// ponytail: only the age is folded, so the same post still keys twice when the two render paths disagree about the
// wrapper ('Feed post' vs 'منشور في سجل الأنشطة') — and which path serves it changes run to run. Map the wrapper words
// and strip the RTL marks to merge them; the email is identical either way, so no recruiter is contacted twice.
const normalize = t => t.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(AR_AGE, (_, n, u) => n + AR_UNIT[u]);
const ageOf = t => (t.match(/\b\d+\s?(mo|m|h|d|w)\b/) || [''])[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const searchUrl = (term, since = SINCE) =>
  `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(term)}&datePosted=%5B%22${since}%22%5D`;

// ---------------- pre-screen ----------------
// Deterministic red flags mirrored from the drafter skill's hard skips. Hints for ordering and display, never verdicts.
// Personal email addresses (gmail etc.) are deliberately NOT a flag: Ahmed's decision, 2026-09-08.
const FLAG_RULES = {
  'residency-gate': /transferable (iqama|qid|visa|sponsorship)|locally available|local(ly)?[- ](candidates?|applicants?|based)( only)?|must (have|hold|be) (a )?(valid )?(work (permit|authori[sz]ation)|resident|residency)|visa[- ]independent|(inside|within) (the )?(uae|ksa|qatar|saudi|kuwait|bahrain|oman)( only)?\b|(uae|ksa|qatar|saudi)[- ]based (candidates?|applicants?) only|work authori[sz]ation (is )?(required|mandatory)/i,
  'immediate-start': /immediate(ly)? (join|start|available)|join(ing)? immediately|immediate joiners?|notice period[: ]*(0|zero|none|nil|immediate)|available (to join )?immediately/i,
  'night-shift': /night shifts?|\b(us|uk|est|pst|cst|ist|eastern|pacific) (shift|hours|timings?|time ?zone|working hours)\b|rotational shifts?/i,
  junior: /\bfresh(ers?|\s+graduates?)\b|\bjuniors?\b|\bintern(ship)?s?\b|\bentry[- ]level\b|\btrainees?\b/i,
};
function prescreen(text, emails) {
  const flags = Object.entries(FLAG_RULES).filter(([, re]) => re.test(text)).map(([f]) => f);
  // required experience: only year phrases tied to experience wording, so "we grew 3x in 2 years" does not count;
  // the largest number of each "N-M years" / "N+ years" phrase ("+" counts as two more); 5 or less is below senior
  const YRS = /(\d{1,2})\s*(\+)?\s*(?:-|–|to)?\s*(\d{1,2})?\s*(\+)?\s*(?:years?|yrs?)/.source;
  const yrs = [...text.matchAll(new RegExp(`(?:experience|exp)\\s*[:\\-–]?\\s*${YRS}|${YRS}(?:\\s+of)?\\s+(?:experience|exp\\b|hands-on|relevant)`, 'gi'))]
    .map(m => { const [a, plus, b, plus2] = m[1] !== undefined ? [m[1], m[2], m[3], m[4]] : [m[5], m[6], m[7], m[8]]; return Math.max(+a, +(b || 0)) + (plus || plus2 ? 2 : 0); });
  if (yrs.length && Math.max(...yrs) <= 5) flags.push('junior-years');
  return flags;
}
let stopping = false; // set by SIGTERM (the UI's Stop); Playwright's own handler only closes Chrome
process.on('SIGTERM', () => { stopping = true; });
// LinkedIn only shows a relative age ('2h', '3d', '2mo'); pin it to an absolute time at scrape time
const AGE_MS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, mo: 30 * 86400e3 };
const postedAt = (age, at = new Date()) => { const m = /^(\d+)\s?(mo|m|h|d|w)$/.exec((age || '').trim()); return m ? new Date(at - m[1] * AGE_MS[m[2]]) : null; };
const notify = msg => { if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "Job Finder"`], () => {}); };

// ---------------- store ----------------
const db = new pg.Pool({ connectionString: DATABASE_URL });
const TABLE_SQL = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'); // shared with ui.js
const insertPost = p => db.query(
  `INSERT INTO posts (key, search_term, author, author_url, posted_age, title, company, location, remote, mena, emails, score, reason, text, flags, posted_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (key) DO NOTHING`,
  [p.key, p.search_term, p.author, p.author_url, p.posted_age, p.title, p.company, p.location, p.remote, p.mena, p.emails, p.score, p.reason, p.text, p.flags, postedAt(p.posted_age)]);

// ---------------- browser ----------------
// Real Chrome from its own profile dir. Chrome refuses automation on the user's main profile,
// so this one is logged into once via --login and reused forever after.
const openBrowser = () => chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, viewport: null, args: ['--window-size=1400,1000', '--lang=en-US'],
  locale: 'en-US', // keep LinkedIn's UI labels in English: the age regex and the dedupe key strip English header words
  ignoreDefaultArgs: ['--enable-automation'], // no "controlled by automated software" bar, navigator.webdriver stays false
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
    const links = [...card.querySelectorAll('a[href*="/in/"],a[href*="/company/"]')]
      .map(x => ({ href: x.href.split('?')[0], text: (x.innerText.trim().split('\n')[0] || '') }));
    if (!links.length) return [];
    // Feed cards can open with "X reposted this" / "X likes this", and X's link comes first: keying on it would
    // store one row per resharer. The real author is linked three times (avatar, name, menu), a resharer twice,
    // so the most repeated href wins; ties keep DOM order, which is the plain author-only card.
    const seen = new Map();
    for (const l of links) seen.set(l.href, (seen.get(l.href) || 0) + 1);
    const authorUrl = [...seen].sort((a, b) => b[1] - a[1])[0][0];
    return [{
      author: links.find(l => l.href === authorUrl && l.text)?.text || '',
      authorUrl,
      text: card.innerText.slice(0, 3000),
      mailtos: [...card.querySelectorAll('a[href^="mailto:"]')].map(m => m.href.slice(7).split('?')[0]),
    }];
  });
}

async function scrapeTerm(page, term) {
  // the literal term 'feed' scrapes the home feed instead of a content search; same card structure, no datePosted filter
  await page.goto(term === 'feed' ? 'https://www.linkedin.com/feed/' : searchUrl(term), { waitUntil: 'domcontentloaded' });
  await sleep(rand(3000, 5000));
  if (/\/(login|authwall|checkpoint)/.test(page.url())) throw Object.assign(new Error('login expired'), { code: 2 });
  await page.waitForSelector('main a[href*="/in/"], main a[href*="/company/"]', { timeout: 20_000 }).catch(() => {});
  await page.mouse.move(500, 400); // over the results column; <main> is the scroll container
  let last = -1, stable = 0, cards = [];
  while (stable < 4 && cards.length < MAX_CARDS) {
    if (stopping) throw new Error('stopped');
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
  cards = (await page.evaluate(readCards)).slice(0, MAX_CARDS);
  if (!cards.length) await page.screenshot({ path: `logs/zero-${term.replace(/\W+/g, '-')}.png` }).catch(() => {}); // what did LinkedIn show?
  return cards;
}

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
const systemPrompt = cv => `You screen LinkedIn job posts for one candidate. Extract fields from the post text and score how well the post matches the candidate's CV, 0-10.
Candidate CV:
"""
${cv}
"""
Candidate target titles: ${TARGET_TITLES.join('; ')}.
Candidate accepts remote roles anywhere, or on-site/hybrid roles in MENA (${MENA}).
Non-software engineering roles (mechanical, electrical, civil, MEP, construction, sales engineering, procurement, QA/QC, BIM) score 0-2 regardless of title words.
is_remote: true only if the post says remote or work from home.
is_mena: true if the location, the company, or the contact email domain (.sa .ae .eg .qa .kw .om .bh .jo .lb .iq .ma .tn .dz) points to MENA.
score: 9-10 the role fits the CV's seniority, stack and domain and the location fits; 6-8 strong stack or domain match with one gap (seniority a step off, adjacent domain, location unclear); 3-5 related software role with a major gap; 0-2 unrelated.
Credit a skill, tool, standard or domain only if the CV text explicitly contains it; never infer or assume it. Anything the post asks for that the CV does not mention is a gap.
Use "unknown" for strings you cannot find. reason: one sentence in the form "Match: <what the CV shows that the post asks for>; Gaps: <what the post asks for that the CV lacks, or none>".`;
let openai, system;
async function loadCv(path) { // the model reads the PDF itself, one call per run; no local PDF parser needed
  openai ??= new OpenAI();
  const r = await openai.responses.create({
    model: MODEL, reasoning: { effort: 'low' },
    input: [{ role: 'user', content: [
      { type: 'input_file', filename: basename(path), file_data: `data:application/pdf;base64,${fs.readFileSync(path).toString('base64')}` },
      { type: 'input_text', text: 'Return the complete plain text of this document verbatim, with no commentary.' },
    ] }],
  });
  console.log(`cv: ${path} (${r.output_text.length} chars)`);
  return r.output_text;
}
async function scorePost(text) {
  openai ??= new OpenAI();
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'system', content: system }, { role: 'user', content: text }],
    text: { format: { type: 'json_schema', name: 'job_post', strict: true, schema: SCHEMA } },
  });
  return JSON.parse(r.output_text);
}

// ---------------- main ----------------
async function run({ dry }) {
  if (opts.jitter && !dry) { // scheduled runs only: break the exact-time pattern
    const ms = rand(0, 30 * 60_000); console.log(`jitter: waiting ${Math.round(ms / 60_000)} min`); await sleep(ms);
  }
  if (!dry) await db.query(TABLE_SQL); // fails fast if Postgres is down, before any browser opens
  const seen = new Set(dry ? [] : (await db.query('SELECT key FROM posts')).rows.map(r => r.key));
  if (!dry) system = systemPrompt(await loadCv(CV_PATH)); // before the browser: a bad CV path fails fast
  const ctx = await openBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  let added = 0;
  try {
    for (const term of dry ? SEARCH_TERMS.slice(0, 1) : SEARCH_TERMS) {
      if (stopping) throw new Error('stopped');
      let cards;
      try { cards = await scrapeTerm(page, term); }
      catch (e) { if (e.code === 2 || stopping || /has been closed/.test(e.message)) throw e; console.error(`[${term}] failed: ${e.message}`); continue; }
      console.log(`[${term}] ${cards.length} cards`);
      for (const c of cards) {
        if (stopping) throw new Error('stopped');
        const text = normalize(c.text); // Arabic-rendered feed cards, before the age regex and the key see them
        const age = ageOf(text);
        const emails = extractEmails(text, c.mailtos);
        const key = dedupeKey(c.authorUrl, text);
        if (dry) { console.log(`- ${key.slice(0, 8)} | ${c.author} | ${age} | ${emails.join(' ') || '-'} | ${text.replace(/\s+/g, ' ').slice(0, 100)}`); continue; }
        if (!emails.length || seen.has(key)) continue;
        seen.add(key);
        let s;
        try { s = await scorePost(text); }
        catch (e) { console.error(`score failed for ${c.author}: ${e.message}; not stored, retried next run`); seen.delete(key); continue; }
        await insertPost({
          key, search_term: term, author: c.author, author_url: c.authorUrl, posted_age: age,
          title: s.title, company: s.company, location: s.location, remote: s.is_remote, mena: s.is_mena,
          emails, score: s.score, reason: s.reason, text, flags: prescreen(text, emails),
        });
        added++;
      }
      if (!dry) await sleep(rand(10000, 20000));
    }
  } finally { await ctx.close().catch(() => {}); await db.end(); }
  console.log(`done: ${added} new rows in posts`);
  if (!dry) notify(`done: ${added} new rows in posts`);
}

async function reflag() {
  await db.query(TABLE_SQL);
  const { rows } = await db.query('SELECT key, text, emails, posted_age, scraped_at FROM posts');
  for (const r of rows) await db.query('UPDATE posts SET flags = $2, posted_at = coalesce(posted_at, $3) WHERE key = $1', [r.key, prescreen(r.text, r.emails || []), postedAt(r.posted_age, new Date(r.scraped_at))]);
  const { rows: [c] } = await db.query('SELECT count(*) FILTER (WHERE cardinality(flags) > 0)::int AS flagged, count(*)::int AS total FROM posts');
  await db.end();
  console.log(`reflagged ${c.total} posts, ${c.flagged} carry at least one flag`);
}

async function rescore() {
  await db.query(TABLE_SQL);
  system = systemPrompt(await loadCv(CV_PATH));
  const { rows } = await db.query('SELECT key, author, text FROM posts ORDER BY scraped_at');
  let n = 0;
  for (const r of rows) {
    try {
      const s = await scorePost(r.text);
      await db.query('UPDATE posts SET title=$2, company=$3, location=$4, remote=$5, mena=$6, score=$7, reason=$8 WHERE key=$1',
        [r.key, s.title, s.company, s.location, s.is_remote, s.is_mena, s.score, s.reason]);
      if (++n % 20 === 0) console.log(`rescored ${n}/${rows.length}`);
    } catch (e) { console.error(`rescore failed for ${r.author}: ${e.message}`); }
  }
  await db.end();
  console.log(`rescored ${n} of ${rows.length} posts`);
}

// ---------------- CLI (keep at the very end: the consts above must be initialised before it runs) ----------------
export { extractEmails, dedupeKey, scorePost, systemPrompt };
if (process.argv[1] === import.meta.filename) { // CLI only when run directly; importable otherwise
  try {
    if (opts['self-test']) selfTest();
    else if (opts.login) await login();
    else if (opts.rescore) await rescore();
    else if (opts.reflag) await reflag();
    else await run({ dry: !!opts['dry-run'] });
  } catch (e) { console.error(e.message); if (!opts['dry-run'] && !opts['self-test']) notify(`failed: ${e.message}`); process.exit(Number.isInteger(e.code) ? e.code : 1); }
}

function selfTest() {
  assert.deepEqual(extractEmails('Send CV to HR@Acme.sa or jobs@x.co.uk today', ['hr@acme.sa']), ['hr@acme.sa', 'jobs@x.co.uk']);
  assert.deepEqual(extractEmails('Email: hr@acme.com.Apply now, or hr@acme.com.Thanks', ['hr@acme.com']), ['hr@acme.com']);
  assert.deepEqual(extractEmails('x@y.COM and a.b@c.co.uk'), ['x@y.com', 'a.b@c.co.uk']);
  assert.deepEqual(extractEmails('no contact here'), []);
  const k1 = dedupeKey('https://www.linkedin.com/in/a', 'x'.repeat(200));
  assert.equal(k1, dedupeKey('https://www.linkedin.com/in/a', 'x'.repeat(160) + 'different tail'));
  assert.notEqual(k1, dedupeKey('https://www.linkedin.com/in/b', 'x'.repeat(200)));
  assert.match(k1, /^[0-9a-f]{40}$/);
  const hdr = age => `Feed post\nHeba Zaki\n • 2nd\nTalent Acquisition\n${age} • \nFollow\nWe are hiring a .NET lead. Send CV to hr@x.com`;
  assert.equal(dedupeKey('u', hdr('21h')), dedupeKey('u', hdr('1d')));
  assert.equal(dedupeKey('u', hdr('21h')), dedupeKey('u', hdr('21h').replace('Follow', 'Following').replace('2nd', '1st')));
  assert.notEqual(dedupeKey('u', hdr('21h')), dedupeKey('u', hdr('21h').replace('.NET lead', 'Java lead')));
  const arab = 'Feed post\n\u200f\u0645\u0646\u0634\u0648\u0631 \u0641\u064a \u0633\u062c\u0644 \u0627\u0644\u0623\u0646\u0634\u0637\u0629\nHeba Zaki\n\u200f\u0663\u200f \u0645\u0646 \u0627\u0644\u0633\u0627\u0639\u0627\u062a \u2022 \nWe are hiring a .NET lead. Send CV to hr@x.com';
  assert.equal(ageOf(normalize(arab)), '3h'); // Arabic-rendered card: '٣ من الساعات' -> '3h'
  assert.equal(dedupeKey('u', normalize(arab)), dedupeKey('u', normalize(arab.replace('\u0663', '\u0664')))); // 3h -> 4h keys the same
  assert.equal(ageOf(normalize('Feed post\nHeba Zaki\n \u2022 2nd\n21h \u2022 ')), '21h'); // '2nd' is not an age
  assert.equal(normalize('\u0665+ \u0633\u0646\u064a\u0646 React'), '5+ \u0633\u0646\u064a\u0646 React'); // digits only where no time unit follows
  assert.match(searchUrl('.net team lead', 'past-24h'), /keywords=\.net%20team%20lead&datePosted=%5B%22past-24h%22%5D$/);
  assert.match(searchUrl('x', 'past-week'), /datePosted=%5B%22past-week%22%5D$/);
  assert.ok(systemPrompt('CV-MARKER-TEXT').includes('CV-MARKER-TEXT') && systemPrompt('x').includes(TARGET_TITLES[0]));
  if (fs.existsSync('config.json') && !opts.terms) assert.deepEqual(SEARCH_TERMS, JSON.parse(fs.readFileSync('config.json', 'utf8')).terms);
  const t0 = new Date('2026-09-08T10:00:00Z');
  assert.equal(postedAt('2h', t0).toISOString(), '2026-09-08T08:00:00.000Z'); assert.equal(postedAt('1d', t0).toISOString(), '2026-09-07T10:00:00.000Z');
  assert.equal(postedAt('36m', t0).toISOString(), '2026-09-08T09:24:00.000Z'); assert.equal(postedAt('2mo', t0).toISOString(), '2026-07-10T10:00:00.000Z');
  assert.equal(postedAt('', t0), null); assert.equal(postedAt('Edited', t0), null);
  assert.deepEqual(prescreen('Senior .NET Lead, 8-12 years, Riyadh. Send CV to hr@acme.sa', ['hr@acme.sa']), []);
  assert.deepEqual(prescreen('Head of Engineering, Riyadh. We grew 3x in 2 years. CV to hr@acme.sa', ['hr@acme.sa']), []);
  assert.deepEqual(prescreen('Requires 2+ years of experience in .NET. hr@acme.sa', ['hr@acme.sa']), ['junior-years']);
  assert.deepEqual(prescreen('Experience: 3-5 years hands-on. hr@acme.sa', ['hr@acme.sa']), ['junior-years']);
  assert.deepEqual(prescreen('10+ years of experience as an architect. hr@acme.sa', ['hr@acme.sa']), []);
  assert.deepEqual(prescreen('Experience: 1+ Year Required. Fresh graduates welcome. CV to admin@x.com', ['admin@x.com']), ['junior', 'junior-years']);
  assert.deepEqual(prescreen('Senior .NET Developer, Alexandria. CV to someone@gmail.com', ['someone@gmail.com']), []); // personal address is not a flag
  assert.deepEqual(prescreen('Must have transferable QID. Immediate joiners only. US shift hours.', ['a@b.com']), ['residency-gate', 'immediate-start', 'night-shift']);
  assert.deepEqual(prescreen('Solution Architect, 10+ years, hiring@company.ae', ['hiring@company.ae']), []);
  console.log('self-test ok');
}
