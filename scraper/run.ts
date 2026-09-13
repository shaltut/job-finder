// scraper/run.ts — drives the installed Chrome through LinkedIn posts, scores survivors against the CV.
//
// This process NEVER writes the database. It emits one JSON object per line on stdout for a writer to
// ingest (the Nitro server, or `scraper/ingest.ts` on the CLI); human-readable progress goes to stderr,
// so stdout stays pure NDJSON.
//
//   node scraper/run.ts --login
//   node scraper/run.ts --dry-run --terms "vue nuxt developer" --max 10
//   node scraper/run.ts | node scraper/ingest.ts
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import Database from 'better-sqlite3'
import OpenAI from 'openai'
import { chromium } from 'playwright-core'
import {
  ageOf, dedupeKey, extractEmails, gateOnPostType, normalize, postedAt, prescreen, rand, resolveUrls, SCORE_SCHEMA, searchUrl,
  sleep, systemPrompt, urnMap
} from './lib.ts'
import type { Config } from './lib.ts'
import { emptySettings, readSettingsFrom } from '../shared/settings.ts'

const { values: opts } = parseArgs({
  options: {
    'terms': { type: 'string', short: 't' },
    'max': { type: 'string', short: 'm' },
    'since': { type: 'string', short: 's' },
    'cv': { type: 'string' },
    'rescore': { type: 'boolean' },
    'reflag': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'login': { type: 'boolean' },
    'jitter': { type: 'boolean' }
  }
})

const MODEL = process.env.JOBFINDER_MODEL || 'gpt-5-nano'
const DB_PATH = process.env.JOBFINDER_DB || 'data/jobfinder.db'
const PROFILE_DIR = process.env.PROFILE_DIR || 'profile'

/**
 * Settings come from the database now, not a config.json this process could drift from. READ-ONLY,
 * like every other query here: server/utils/db.ts makes the Nitro server the sole writer, and two
 * writers is how you get SQLITE_BUSY under a long scrape.
 *
 * Passing them in on stdin from the server was the alternative and was rejected — it would break
 * `npm run dry`, --rescore, --reflag and the `node scraper/run.ts | node scraper/ingest.ts` pipe,
 * all of which run with no server at all.
 */
function loadConfig(): Config {
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    db.pragma('busy_timeout = 5000')
    const cfg = readSettingsFrom(db)
    db.close()
    if (cfg) return cfg
  } catch { /* no database yet, or no settings row: fall through to the defaults below */ }
  return emptySettings()
}

const CONFIG = loadConfig()
// argv still wins over the stored settings, and the hardcoded fallbacks stay as the last resort
const SEARCH_TERMS = opts.terms ? opts.terms.split(',').map(t => t.trim()).filter(Boolean) : CONFIG.terms
const MAX_CARDS = Number(opts.max) || CONFIG.max || 40
const SINCE = opts.since || CONFIG.since || 'past-24h'
const CV_PATH = opts.cv || CONFIG.cv

// ---------------- output ----------------
/** One NDJSON record on stdout. The only channel through which data leaves this process. */
const emit = (rec: Record<string, unknown>) => process.stdout.write(JSON.stringify(rec) + '\n')
const log = (msg: string) => process.stderr.write(msg + '\n')
const notify = (msg: string) => {
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "Job Finder"`], () => {})
  }
}

let stopping = false // set by SIGTERM (the UI's Stop); Playwright's own handler only closes Chrome
process.on('SIGTERM', () => {
  stopping = true
})
function checkStop() {
  if (stopping) throw new Error('stopped')
}

/** Read-only: this process must never take a write lock. Returns the keys already stored. */
function knownKeys(): Set<string> {
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    db.pragma('busy_timeout = 5000')
    const rows = db.prepare('SELECT key FROM posts').all() as { key: string }[]
    db.close()
    return new Set(rows.map(r => r.key))
  } catch {
    return new Set() // no database yet: nothing has been scraped
  }
}

// ---------------- browser ----------------
// Real Chrome from its own profile dir. Chrome refuses automation on the user's main profile, so this one
// is logged into once via --login and reused forever after.
const openBrowser = () => chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: null,
  args: ['--window-size=1400,1000', '--lang=en-US'],
  locale: 'en-US', // keep LinkedIn's UI labels in English; normalize() handles the cards it serves in Arabic anyway
  ignoreDefaultArgs: ['--enable-automation'] // no "controlled by automated software" bar; navigator.webdriver stays false
})

async function login() {
  const ctx = await openBrowser()
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto('https://www.linkedin.com/login')
  log('Log in inside the Chrome window (tick "Keep me signed in"). Waiting up to 5 minutes...')
  await page.waitForURL(/linkedin\.com\/feed/, { timeout: 300_000 })
  log(`Logged in. Session saved in ./${PROFILE_DIR}`)
  await ctx.close()
}

// ---------------- scraping ----------------
// Runs inside the page. LinkedIn's class names are hashed and the rendered DOM carries no post URN, so cards
// are found structurally: the container whose children each hold an author link. The one usable id on a card
// is `expanded<token>FeedType_...`; the token is opaque, but `urnMap` in lib.ts resolves it to the post's URN
// from the React-server payload that rendered the page — LinkedIn strips URNs from the HTML, not from that.
function readCards() {
  const main = document.querySelector('main')
  if (!main) return []
  const lists = [...main.querySelectorAll('div')]
    .map(e => ({ e, n: [...e.children].filter(c => c.querySelector('a[href*="/in/"],a[href*="/company/"]')).length }))
    .filter(x => x.n >= 2).sort((a, b) => b.n - a.n)
  const list = lists[0]?.e
  if (!list) return []
  return [...list.children].flatMap((card) => {
    const links = [...card.querySelectorAll('a[href*="/in/"],a[href*="/company/"]')]
      .map(x => ({ href: (x as HTMLAnchorElement).href.split('?')[0]!, text: ((x as HTMLElement).innerText.trim().split('\n')[0] || '') }))
    if (!links.length) return []
    // Feed cards can open with "X reposted this", and X's link comes first: keying on it would store one row
    // per resharer. The real author is linked three times (avatar, name, menu), a resharer twice, so the most
    // repeated href wins; ties keep DOM order, which is the plain author-only card.
    const seen = new Map<string, number>()
    for (const l of links) seen.set(l.href, (seen.get(l.href) || 0) + 1)
    const authorUrl = [...seen].sort((a, b) => b[1] - a[1])[0]![0]
    return [{
      author: links.find(l => l.href === authorUrl && l.text)?.text || '',
      authorUrl,
      text: (card as HTMLElement).innerText.slice(0, 3000),
      mailtos: [...card.querySelectorAll('a[href^="mailto:"]')].map(m => (m as HTMLAnchorElement).href.slice(7).split('?')[0]!),
      // never card.closest(): that walks up to a shared ancestor and would give every card one id
      token: card.querySelector('[id^="expanded"],[id^="collapsed"]')?.id ?? null
    }]
  })
}

type Card = { author: string, authorUrl: string, text: string, mailtos: string[], token: string | null }

async function scrapeTerm(page: import('playwright-core').Page, term: string): Promise<(Card & { postUrl: string | null })[]> {
  // Post permalinks: the URNs ride in the payloads that render the results — the document itself, then the
  // pagination endpoint as scrolling loads more — so they are collected passively here, with no extra
  // request. Search only: the home feed batches its state keys and offers no way to tell which URN belongs
  // to which card (see urnMap), so feed posts are stored with no URL rather than a wrong one.
  // The page is reused across terms, so the listener comes off again in the finally below: left on, one
  // would accumulate per term and every payload would be parsed nine times over.
  const urns = new Map<string, string>()
  const collect = async (res: import('playwright-core').Response) => {
    if (!/linkedin\.com/.test(res.url()) || /\.(js|css|png|jpe?g|svg|gif|woff2?)(\?|$)/.test(res.url())) return
    try {
      for (const [tok, urn] of urnMap(await res.text())) if (!urns.has(tok)) urns.set(tok, urn)
    } catch { /* body already discarded: the next scroll response carries the same cards */ }
  }
  if (term !== 'feed') page.on('response', collect)
  try {
    // the literal term 'feed' scrapes the home feed instead of a content search: same cards, no datePosted filter
    await page.goto(term === 'feed' ? 'https://www.linkedin.com/feed/' : searchUrl(term, SINCE), { waitUntil: 'domcontentloaded' })
    await sleep(rand(3000, 5000))
    if (/\/(login|authwall|checkpoint)/.test(page.url())) throw Object.assign(new Error('login expired'), { code: 2 })
    await page.waitForSelector('main a[href*="/in/"], main a[href*="/company/"]', { timeout: 20_000 }).catch(() => {})
    await page.mouse.move(500, 400) // over the results column; <main> is the scroll container
    let last = -1
    let stable = 0
    let cards: Card[] = []
    while (stable < 4 && cards.length < MAX_CARDS) {
      checkStop()
      await page.mouse.wheel(0, 4000)
      await sleep(rand(2000, 5000))
      cards = await page.evaluate(readCards) as Card[]
      stable = cards.length === last ? stable + 1 : 0
      last = cards.length
    }
    // reverse order: each click removes a button, so a forward loop over index locators skips every other one
    const more = await page.locator('main button', { hasText: /…\s*more$/ }).all()
    for (const b of more.reverse()) await b.click({ timeout: 2000 }).catch(() => {})
    await sleep(1000)
    cards = (await page.evaluate(readCards) as Card[]).slice(0, MAX_CARDS)
    if (!cards.length) {
      fs.mkdirSync('logs', { recursive: true })
      await page.screenshot({ path: `logs/zero-${term.replace(/\W+/g, '-')}.png` }).catch(() => {}) // what did LinkedIn show?
    }
    const urls = resolveUrls(cards.map(c => c.token), urns)
    return cards.map((c, i) => ({ ...c, postUrl: urls[i] ?? null }))
  } finally {
    page.off('response', collect)
  }
}

// ---------------- scoring ----------------
let openai: OpenAI | undefined
let system: string

async function loadCv(path: string) { // the model reads the PDF itself, one call per run; no local PDF parser
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'user', content: [
      { type: 'input_file', filename: basename(path), file_data: `data:application/pdf;base64,${fs.readFileSync(path).toString('base64')}` },
      { type: 'input_text', text: 'Return the complete plain text of this document verbatim, with no commentary.' }
    ] }]
  } as never) as { output_text: string }
  log(`cv: ${path} (${r.output_text.length} chars)`)
  return r.output_text
}

interface Score {
  post_type: 'hiring' | 'seeking' | 'other'
  title: string
  company: string
  location: string
  is_remote: boolean
  is_in_scope: boolean
  score: number
  reason: string
}

async function scorePost(text: string): Promise<Score> {
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'system', content: system }, { role: 'user', content: text }],
    text: { format: { type: 'json_schema', name: 'job_post', strict: true, schema: SCORE_SCHEMA } }
  } as never) as { output_text: string }
  return gateOnPostType(JSON.parse(r.output_text) as Score)
}

// ---------------- main ----------------
async function run({ dry }: { dry: boolean }) {
  if (opts.jitter && !dry) { // scheduled runs only: break the exact-time pattern
    const ms = rand(0, 30 * 60_000)
    log(`jitter: waiting ${Math.round(ms / 60_000)} min`)
    await sleep(ms)
  }
  if (!SEARCH_TERMS.length) throw new Error('no search terms configured — open Settings and add at least one')
  if (!dry && !CV_PATH) throw new Error('no CV configured — upload one in Settings')
  const seen = dry ? new Set<string>() : knownKeys()
  if (!dry) system = systemPrompt(await loadCv(CV_PATH), CONFIG) // before the browser: a bad CV path fails fast
  const ctx = await openBrowser()
  const page = ctx.pages()[0] || await ctx.newPage()
  let added = 0
  try {
    for (const term of dry ? SEARCH_TERMS.slice(0, 1) : SEARCH_TERMS) {
      checkStop()
      let cards: Card[]
      try {
        cards = await scrapeTerm(page, term)
      } catch (e) {
        const err = e as Error & { code?: number }
        if (err.code === 2 || stopping || /has been closed/.test(err.message)) throw err
        log(`[${term}] failed: ${err.message}`)
        continue
      }
      log(`[${term}] ${cards.length} cards`)
      for (const c of cards) {
        checkStop()
        const text = normalize(c.text) // Arabic-rendered cards, before the age regex and the key see them
        const age = ageOf(text)
        const emails = extractEmails(text, c.mailtos)
        const key = dedupeKey(c.authorUrl, text)
        if (dry) {
          log(`- ${key.slice(0, 8)} | ${c.author} | ${age || '-'} | ${emails.join(' ') || '-'} | ${c.postUrl || 'NO URL'} | ${text.replace(/\s+/g, ' ').slice(0, 80)}`)
          continue
        }
        if (!emails.length) continue
        if (seen.has(key)) {
          // Already stored, so it is deliberately not scored again — but a row from before permalinks
          // existed, or from the feed, may still have no URL. This is the only moment the URL is in hand.
          if (c.postUrl) emit({ op: 'posturl', key, postUrl: c.postUrl })
          continue
        }
        seen.add(key)
        let s: Score
        try {
          s = await scorePost(text)
        } catch (e) {
          // not stored, so the post is retried next run instead of sitting with a NULL score
          log(`score failed for ${c.author}: ${(e as Error).message}; not stored, retried next run`)
          seen.delete(key)
          continue
        }
        emit({
          op: 'post',
          key,
          searchTerm: term,
          author: c.author,
          authorUrl: c.authorUrl,
          postUrl: c.postUrl,
          postedAge: age || null,
          postedAt: postedAt(age)?.toISOString() ?? null,
          postType: s.post_type,
          title: s.title,
          company: s.company,
          location: s.location,
          remote: s.is_remote,
          inScope: s.is_in_scope,
          emails,
          score: s.score,
          reason: s.reason,
          text,
          flags: prescreen(text, CONFIG)
        })
        added++
      }
      if (!dry) await sleep(rand(10000, 20000))
    }
  } finally {
    await ctx.close().catch(() => {})
  }
  emit({ op: 'done', added })
  log(`done: ${added} new rows`)
  if (!dry) notify(`done: ${added} new rows in posts`)
}

/** Recompute pre-screen flags and backfill posted_at for every stored post. No API calls. */
function reflag() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  const rows = db.prepare('SELECT key, text, emails, posted_age, scraped_at FROM posts').all() as
    { key: string, text: string, emails: string, posted_age: string | null, scraped_at: number }[]
  db.close()
  let flagged = 0
  for (const r of rows) {
    const flags = prescreen(r.text, CONFIG)
    if (flags.length) flagged++
    emit({ op: 'reflag', key: r.key, flags, postedAt: postedAt(r.posted_age, new Date(r.scraped_at * 1000))?.toISOString() ?? null })
  }
  emit({ op: 'done', added: 0 })
  log(`reflagged ${rows.length} posts, ${flagged} carry at least one flag`)
}

/** Rescore every stored post against the current CV and prompt. */
async function rescore() {
  if (!CV_PATH) throw new Error('no CV configured — upload one in Settings')
  system = systemPrompt(await loadCv(CV_PATH), CONFIG)
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  const rows = db.prepare('SELECT key, author, text FROM posts ORDER BY scraped_at').all() as
    { key: string, author: string, text: string }[]
  db.close()
  let n = 0
  for (const r of rows) {
    checkStop()
    try {
      const s = await scorePost(r.text)
      emit({
        op: 'update', key: r.key, postType: s.post_type,
        title: s.title, company: s.company, location: s.location,
        remote: s.is_remote, inScope: s.is_in_scope, score: s.score, reason: s.reason
      })
      if (++n % 20 === 0) log(`rescored ${n}/${rows.length}`)
    } catch (e) {
      log(`rescore failed for ${r.author}: ${(e as Error).message}`)
    }
  }
  emit({ op: 'done', added: n })
  log(`rescored ${n} of ${rows.length} posts`)
}

try {
  if (opts.login) await login()
  else if (opts.rescore) await rescore()
  else if (opts.reflag) reflag()
  else await run({ dry: !!opts['dry-run'] })
} catch (e) {
  const err = e as Error & { code?: number }
  log(err.message)
  if (!opts['dry-run']) notify(`failed: ${err.message}`)
  process.exit(Number.isInteger(err.code) ? err.code! : 1)
}
