// Properties that must hold for the whole server, checked over the source rather than at runtime.
// Each one is a mistake that would be silent and expensive if it were ever reintroduced.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|js|vue)$/.test(name)) out.push(p)
  }
  return out
}

// shared/ holds the settings schema and EMPTY_SETTINGS, which are exactly the kind of place a real
// address would get seeded into. The identity scan below is worthless if it cannot see them.
const serverFiles = [...walk('server'), ...walk('shared')]
const read = (p: string) => readFileSync(p, 'utf8')

test('the server never sends mail: it only ever creates drafts', () => {
  // `gmail.compose` includes permission to send, so never-sending is a property of this code, not of the
  // credential. If a send call is ever added, this test is the thing that catches it.
  const forbidden = /\bmessages\.send\b|\bdrafts\/send\b|\bdrafts\.send\b|users\.messages\.send|\/send\b/
  const offenders = serverFiles.filter(f => forbidden.test(read(f)))
  assert.deepEqual(offenders, [], `these files look like they can send mail: ${offenders.join(', ')}`)
})

test('the drafter runs from a neutral directory, never the project root', () => {
  // `claude -p` loads the CLAUDE.md of its cwd. Running it in the project folder leaked the previous
  // owner's name into a drafter report; the identity in the appended prompt must be the only one it sees.
  const src = read('server/utils/drafter.ts')
  // the prompt file lives in that same directory, so the path is held once and handed to spawn
  assert.match(src, /const cwd = neutralCwd\(\)/, 'the drafter must take its cwd from neutralCwd()')
  assert.match(src, /spawn\('claude', args, \{ cwd,/, 'and spawn claude there')
  assert.doesNotMatch(src, /spawn\(\s*'claude'[^)]*cwd:\s*process\.cwd\(\)/s, 'the drafter must not spawn in the project root')
})

test('the drafter loads no user CLAUDE.md, hooks or plugins, and names its model', () => {
  // neutralCwd() only avoids the PROJECT CLAUDE.md. Without this flag the user-global one and every
  // SessionStart hook reached the drafter (measured 2026-09-25) — a title contradicting Settings, and three
  // plugins' instructions, inside a JSON-only run. Dropping user settings also drops their model choice.
  const src = read('server/utils/drafter.ts')
  assert.match(src, /'--setting-sources', 'local'/, 'user settings, memory and hooks must not load')
  assert.match(src, /'--model', DRAFTER_MODEL/, 'the model must be explicit once user settings are skipped')
  const from = src.indexOf('\'-p\'')
  const to = src.indexOf('\'--allowed-tools\'', from)
  assert.ok(from >= 0 && to > from, 'anchors: the -p flag and the tool flags')
  const args = src.slice(from, to)
  assert.match(args, /--setting-sources/, 'and it must come before the variadic tool flags, or they swallow it')
})

test('the drafter prompt travels in a file, never on the command line', () => {
  // On the command line Windows capped it at 32,767 characters; a 28,000 budget standing in for that cap
  // was exceeded by 165 on 2026-09-26 and switched CV tailoring off with nothing but a log line.
  const src = read('server/utils/drafter.ts')
  assert.match(src, /'--append-system-prompt-file', promptFile/)
  assert.doesNotMatch(src, /'--append-system-prompt',/, 'the argv form must not come back')
  assert.match(src, /\.finally\(\(\) => rmSync\(promptFile/, 'and the file, which holds the whole profile, is removed after every run')
})

test('the drafter is granted no usable tools', () => {
  const src = read('server/utils/drafter.ts')
  assert.match(src, /--strict-mcp-config/, 'MCP servers must be skipped')
  assert.match(src, /'--allowed-tools', 'NoToolsPermitted'/, 'the allow list must name no real tool')
  for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch']) {
    assert.ok(new RegExp(`'${tool}'`).test(src), `${tool} must be in the deny list`)
  }
})

test('the contacts upsert can never resurrect a \'final\' recruiter', () => {
  // two emails per address, ever — enforced by the database, not by prose
  const src = read('server/utils/drafts.ts')
  assert.match(src, /WHERE contacts\.stage <> 'final'/, 'the contacts upsert must carry WHERE stage <> \'final\'')
})

test('the schema keeps the lower-case email constraint', () => {
  assert.match(read('server/db/schema.ts'), /lower\(/, 'contacts.email must be constrained to lower case')
})

// The identity scan that used to live here is now test/identity.test.ts. It was replaced rather than
// widened: it matched three literals over server/ + shared/, one of which was the previous owner's
// company domain — so the guard against hardcoded identities hardcoded an identity. It also could not
// have caught the bug that motivated the rewrite, a name spelled out in the drafter's prompt.

test('drafting refuses to start without the background it argues from', () => {
  // missingForDrafting() existed with no consumer for one commit, while the Settings badge already
  // said 'drafting blocked' and SETUP.md promised a refusal. A gate nothing calls is worse than no
  // gate: it reads as enforced everywhere it is described.
  const src = read('server/utils/jobs.ts')
  assert.match(src, /const config = readConfigForDraft\(\)/, 'runDraftJob must gate on readConfigForDraft()')
  assert.match(read('server/utils/config.ts'), /missingForDrafting\(cfg\)/, 'the draft gate must consult missingForDrafting')
  // the sweep only reads sent mail and makes no new claims, so it must NOT be gated on evidence
  assert.match(src, /const config = readConfig\(\)/, 'runSyncJob must keep the looser gate')
})

test('a skip can never downgrade a post an email already names', () => {
  // Found live: re-drafting a recruiter whose draft was pending rewrote the post's verdict from
  // 'drafted' to 'skipped', losing the `named in ...` prefix the follow-up query depends on.
  const src = readFileSync('server/utils/jobs.ts', 'utf8')
  const skipInsert = src.slice(src.indexOf('VALUES (?, \'skipped\''))
  assert.match(
    skipInsert.slice(0, 400),
    /WHERE applications\.verdict <> 'drafted'/,
    'the closed-recruiter skip must carry WHERE applications.verdict <> \'drafted\''
  )
})

/**
 * The three queries that decide who receives an email, each sliced out on its own.
 *
 * Scoped rather than matched over whole files, because a file-wide regex is satisfied by ANY one of
 * them keeping the clause: dropping it from the batch queue alone used to leave this suite green.
 */
function emailingQueries(): Record<string, string> {
  const jobs = readFileSync('server/utils/jobs.ts', 'utf8')
  const sync = readFileSync('server/utils/sync.ts', 'utf8')
  const contacts = readFileSync('server/utils/contacts.ts', 'utf8')
  const draftRows = readFileSync('server/utils/draft-rows.ts', 'utf8')
  // The keyed draft query moved into keyedDraftRows() for the same reason, and screened bulk Draft with it.
  assert.match(jobs, /keyedDraftRows\(db, args\.keys, !!args\.screened\)/, 'the keyed draft path must select through keyedDraftRows()')
  // The follow-up's selection moved into followUpPosts() so it could be tested against a real database;
  // pin that the sweep still runs it, or the query below could be dead code carrying the right clauses.
  assert.match(sync, /followUpPosts\(db, email, replyTo\.date\)/, 'the follow-up sweep must select through followUpPosts()')
  // An anchor that is not found makes indexOf -1 and the slice silently wrong — fail on the anchor instead.
  const between = (src: string, from: string, to: string) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a)
    assert.ok(a >= 0 && b > a, `anchor not found: ${from} .. ${to}`)
    return src.slice(a, b)
  }
  return {
    'the batch drafter queue': between(jobs, 'LEFT JOIN applications a ON a.key = p.key', 'ORDER BY p.score DESC'),
    'the keyed draft path': between(draftRows, 'WHERE p.key IN', '.all(JSON.stringify(keys))'),
    'the follow-up sweep': between(contacts, 'export function followUpPosts', 'ORDER BY named DESC')
  }
}

test('a dismissed post is out of every query that decides who receives an email', () => {
  // Dismissal is the owner saying "not this one". Every selection site must carry the clause — the
  // follow-up sweep included, since it finds unmentioned roles by the absence of a `named in ...` row
  // and would otherwise treat every dismissed post as fair game.
  for (const [what, sql] of Object.entries(emailingQueries())) {
    assert.match(sql, /dismissed_at IS NULL/, `${what} must exclude dismissed posts`)
  }
})

test('a post the owner applied to by hand is out of those same queries', () => {
  // The mirror of the dismissal rule, and it fails louder: the owner has already written to this
  // company through the post's own link, so a draft here is a second approach about one role.
  for (const [what, sql] of Object.entries(emailingQueries())) {
    assert.match(sql, /applied_at IS NULL/, `${what} must exclude posts the owner already applied to`)
  }
})

test('the drafter queue still skips flagged posts', () => {
  // This is what makes the owner's exclude list true. `excluded` is an ordinary entry in `flags`, so
  // the list only removes anything from the queue for as long as this predicate stands — and losing
  // it fails silently: every rule keeps matching, the UI keeps hiding, and the drafter keeps emailing
  // the company the owner told it to never contact again.
  const jobs = readFileSync('server/utils/jobs.ts', 'utf8')
  const queue = jobs.slice(jobs.indexOf('LEFT JOIN applications a ON a.key = p.key'))
  assert.match(
    queue.slice(0, 900),
    /json_array_length\(p\.flags\) = 0/,
    'the drafter queue must keep its flags guard'
  )
})

test('the drafter queue still requires an email address', () => {
  // This guard used to be free: the scraper stored a post only if its text carried an address, so
  // every row satisfied it. Now that a post can be admitted on its link or its phone number alone, it
  // is the only thing standing between a link-only post and the contacts upsert, whose `email` column
  // is NOT NULL with a lower-case CHECK. Losing it is an exception thrown mid-draft, or worse a row
  // keyed on an empty string.
  const jobs = readFileSync('server/utils/jobs.ts', 'utf8')
  const queue = jobs.slice(jobs.indexOf('LEFT JOIN applications a ON a.key = p.key'))
  assert.match(
    queue.slice(0, 900),
    /json_array_length\(p\.emails\) > 0/,
    'the drafter queue must keep its emails guard'
  )
})

test('the manual-apply column is a post column, not an applications verdict', () => {
  // A third verdict would be read by the follow-up sweep, which finds unmentioned roles by the ABSENCE
  // of a `named in ...` reason — so a manual row would look like a role still owed an email. The
  // Verdict union is the cheapest place to catch someone reaching for that shape again.
  const types = readFileSync('app/types/index.d.ts', 'utf8')
  const verdict = /export type Verdict = ([^\n]+)/.exec(types)?.[1] ?? ''
  assert.ok(verdict.includes('\'drafted\'') && verdict.includes('\'skipped\''), 'the two real verdicts stay')
  assert.ok(
    !/manual|applied/i.test(verdict),
    'a manual application is posts.applied_at, never an applications verdict'
  )
})

test('the OAuth callback checks the state nonce BEFORE exchanging the code', () => {
  // Google's redirect into the callback is a cross-site GET that no Origin/Sec-Fetch guard can cover.
  // Without this, any page open in the browser could hand us its own code. Ported from upstream e8be7b6.
  const src = readFileSync('server/api/gmail/callback.get.ts', 'utf8')
  const stateAt = src.indexOf('consumeAuthState')
  const exchangeAt = src.indexOf('exchangeCode(')
  assert.ok(stateAt > 0, 'the callback must consume the state nonce')
  assert.ok(exchangeAt > stateAt, 'the state check must come before the code exchange')
  assert.match(src, /statusCode: 400/, 'a bad state must be a 400')
})

test('the state nonce is one-shot, so a replayed callback fails too', () => {
  const src = readFileSync('server/utils/gmail.ts', 'utf8')
  const fn = src.slice(src.indexOf('export function consumeAuthState'))
  assert.match(fn.slice(0, 300), /__jobfinderAuthState = null/, 'the nonce must be cleared on use')
})

test('the Gmail scopes cover the sweep as well as drafting', () => {
  const src = readFileSync('server/utils/gmail.ts', 'utf8')
  assert.match(src, /gmail\.compose/)
  // the sweep searches sent mail with q=, which the narrower gmail.metadata scope rejects
  assert.match(src, /gmail\.readonly/)
})

test('config.json is not read anywhere: the database is the only source of settings', () => {
  // It was git-tracked and therefore carried a real phone number and email address into the repo.
  // The one permitted mention is the one-time import in the migrate plugin, which carries the old
  // file across on first boot and then never touches it again.
  // comments may still name the file to explain the migration, so strip them first — as the
  // identity test above does — and look only at code
  const offenders = [...serverFiles, 'scraper/run.ts', 'scraper/lib.ts']
    .filter(f => f !== join('server', 'plugins', 'migrate.ts')) // join, not a literal: walk() emits backslashes on Windows
    .filter((f) => {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      return /config\.json/.test(code)
    })
  assert.deepEqual(offenders, [], `these files still read config.json: ${offenders.join(', ')}`)
})

test('the follow-up never sends the model its own subject: Gmail threads only on a matching Subject', () => {
  // The procedure has always said "Return no subject (the thread's is inherited)" — and on 17 Sep the
  // model returned "Follow up" anyway, on a draft nothing threaded. Same lesson as gateOnPostType() and
  // PLACEHOLDER: a rule the email depends on belongs in code, not in the prompt.
  const sync = readFileSync('server/utils/sync.ts', 'utf8')
  const fn = sync.slice(sync.indexOf('async function draftFollowUp'))
  assert.ok(!/carrier\.subject/.test(fn), 'the follow-up subject must come from the application, not the model')
  assert.ok(/replyHeaders\(/.test(fn), 'the follow-up must build its headers from the application message')
})

test('the draft gate asks Gmail, and still falls back to the cache without a token', () => {
  // `contacts` is only ever as fresh as the last sweep: a recruiter who replied still reads `contacted`,
  // and one written to outside this app has no row at all. Reverting to the cache alone would be silent —
  // the run would look identical and simply email people mid-conversation. The fallback is equally
  // load-bearing in the other direction: without it a machine with no google-oauth.json cannot draft.
  const jobs = readFileSync('server/utils/jobs.ts', 'utf8')
  // the per-recruiter body: a pool since 2026-10-03 (recruiters in parallel), a for-loop before
  const start = jobs.indexOf('await pool([...groups]')
  assert.ok(start > 0, 'anchor: the per-recruiter pool in runDraftJob')
  const loop = jobs.slice(start, jobs.indexOf('const cc = ccFrom'))
  assert.match(loop, /closedInGmail\(/, 'the per-recruiter gate must consult Gmail when a token exists')
  assert.match(loop, /isClosed\(/, 'and must fall back to the contacts cache when it does not')
})

test('CV rendering never touches the LinkedIn profile: a fresh headless browser, never a persistent one', () => {
  // The draft lane runs alongside the scrape lane, which holds ./profile's lock for the whole scrape. A
  // renderer that opened it would fail every tailored CV during a scrape, or break the scrape itself.
  const src = readFileSync('server/utils/cv-render.ts', 'utf8')
  assert.doesNotMatch(src, /launchPersistentContext|PROFILE_DIR|user-data-dir|['"`]\.\/profile/)
  assert.match(src, /headless:\s*true/)
})

test('a draft job closes its database handle whatever the browser does', () => {
  // Awaiting renderer.close() first made the sqlite close conditional on Playwright: a rejection leaked
  // the handle and a hang left the draft lane wedged on globalThis until a server restart, where an HMR
  // reload cannot reach it. The kicked-off-then-awaited shape is what keeps the two independent.
  const jobs = readFileSync('server/utils/jobs.ts', 'utf8')
  const kickOff = 'const closingBrowser = renderer.close().catch('
  const start = jobs.indexOf(kickOff)
  assert.ok(start > 0, 'the browser close must be started, with its rejection handled, not awaited first')
  const dbClose = jobs.indexOf('close()', start + kickOff.length)
  const awaited = jobs.indexOf('await closingBrowser', start)
  assert.ok(dbClose > 0 && awaited > 0 && dbClose < awaited, 'close() must run before the browser is awaited')
})

test('the drafter keeps the cv block untyped, so a malformed CV can never fail an email', () => {
  const src = readFileSync('server/utils/drafter.ts', 'utf8')
  assert.match(src, /cv:\s*z\.unknown\(\)\.optional\(\)/)
})

test('switching tailoring off returns follow-ups to the uploaded PDF, not only new applications', () => {
  const sync = readFileSync('server/utils/sync.ts', 'utf8')
  const fn = sync.slice(sync.indexOf('async function draftFollowUp'))
  // The else branch is the half that matters: it IS the rollback lever. A regex stopping at
  // `followUpAttachment(` would stay green if someone rewrote `: config.cv` to `: null`.
  assert.match(fn, /config\.tailorCv\s*\?\s*followUpAttachment\([^)]*\)\s*:\s*config\.cv/)
})

test('Stop reaches a running sync: the signal is threaded from the lane to every drafter run', () => {
  // It used to stop at jobs.ts — Stop said the job stopped while the sweep ran an Opus session per due
  // recruiter on the draft lane, blocking every draft behind it.
  const jobs = read('server/utils/jobs.ts')
  const sync = read('server/utils/sync.ts')
  assert.match(jobs, /runSyncJob\(push, abort\.signal\)/)
  assert.match(jobs, /sweep\(db, config, [^)]*, push, signal\)/)
  assert.match(sync, /if \(signal\?\.aborted\)/, 'the sweep loop checks it between recruiters')
  assert.match(sync, /draftFollowUp\(db, config, c\.email, onLog, d\.replyTo, signal\)/)
  assert.match(sync, /runDrafter\(req, config, \{ onLog, signal \}\)/, 'and the running claude session is killed with it')
})

test('the sweep caches a stage through cachedStage(), never the raw decision', () => {
  // The review found reverting this call left all 361 tests green, and the raw d.stage is the bug that
  // marked 76 recruiters followed_up with no follow-up written.
  const sync = read('server/utils/sync.ts')
  assert.match(sync, /const cached = cachedStage\(d\)/)
  assert.match(sync, /stage: cached\.stage,/)
  assert.doesNotMatch(sync, /stage: d\.stage,/)
})

test('a settings save that changes a flag input re-flags from the server, whichever tab sent it', () => {
  // The page decided this against its own load-time copy, so a stale tab could write old flag inputs back
  // and skip the re-flag; the review also found reverting the page's flagInputs call left every test green.
  const put = read('server/api/config.put.ts')
  assert.match(put, /const before = flagInputs\(readConfigLoose\(\)\)/)
  assert.match(put, /if \(flagInputs\(saved\) !== before\) enqueue\('reflag'\)/)
  assert.match(read('server/api/settings/excludes.post.ts'), /enqueue\('reflag'\)/)
  assert.match(read('server/utils/jobs.ts'), /kind === 'reflag' && queue\.some\(q => q\.kind === 'reflag'\)/, 'and a second request while one is queued is a no-op')
})

test('the excludes endpoint takes a list and still queues exactly one reflag', () => {
  // Source-level: the handler is a Nitro event handler no test here can import.
  const src = readFileSync('server/api/settings/excludes.post.ts', 'utf8')
  assert.match(src, /needles:/, 'a bulk Exclude posts several names in one request')
  assert.equal(src.split(`enqueue('reflag')`).length - 1, 1, 'one reflag per request, however many needles')
})

test('a bulk Exclude of a full page fits the endpoint cap', () => {
  // The bulk dialog offers each selected row's company and recruiter: up to 2 x 100 rows. A lower cap
  // rejected the whole request with a validation blob the toast could not explain.
  const src = readFileSync('server/api/settings/excludes.post.ts', 'utf8')
  const cap = Number(src.match(/needles: z\.array\(needle\)\.min\(1\)\.max\(([0-9]+)\)/)?.[1])
  assert.ok(cap >= 200, `needles cap is ${cap}, a full page can need 200`)
})

test('every tags field on Settings commits what was typed when it loses focus', () => {
  // UInputTags adds a tag only on Enter by default. Typed text left in the box was silently dropped by
  // Save — measured 2026-10-03: the exclude list stayed [] however often the owner "saved" it.
  const src = readFileSync('app/pages/settings.vue', 'utf8')
  const tags = src.split('<UInputTags').slice(1).map(s => s.slice(0, s.indexOf('/>')))
  assert.ok(tags.length >= 9, `anchor: found ${tags.length} UInputTags`)
  for (const t of tags) assert.match(t, /add-on-blur/, `a UInputTags without add-on-blur: ${t.trim().split('\n')[0]}`)
})
