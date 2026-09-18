import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadCv, scorePost } from '../scraper/score.ts'
import { emptySettings } from '../shared/settings.ts'
import { PASTED_TERM, pasteGate, pasteRecord } from '../server/utils/paste.ts'

// scraper/ has no typecheck coverage, so a broken lift there fails at run time and nowhere else.
// This is cheap and catches a syntax error, a bad import path and a changed arity.
test('the scorer is importable and keeps its shape', () => {
  assert.equal(typeof loadCv, 'function')
  assert.equal(typeof scorePost, 'function')
  // 2, not 1: Node strips the type annotations, and TypeScript's `?` leaves a plain parameter behind.
  // Function.length only stops counting at the first parameter with a default value.
  assert.equal(loadCv.length, 2, 'loadCv takes (path, log?)')
  assert.equal(scorePost.length, 2, 'scorePost takes (text, system)')
})

const POST = [
  'Senior .NET Developer is required for a full-time job remotely.',
  '5+ years of experience in backend software development.',
  'C#, .NET Core, ASP.NET MVC, Entity Framework, SQL Server.',
  'apply by sending your resume to recruiter@example.com'
].join('\n')

const cfg = (over = {}) => ({ ...emptySettings(), contactChannels: ['email'], ...over })

test('pasteGate admits a post carrying an enabled channel', () => {
  const g = pasteGate(POST, cfg())
  assert.equal(g.ok, true)
  if (g.ok) {
    assert.deepEqual(g.found.emails, ['recruiter@example.com'])
    assert.ok(g.channels.includes('email'))
    assert.match(g.key, /^[0-9a-f]{40}$/)
  }
})

test('pasteGate refuses a post with no enabled channel, and says what it found', () => {
  const g = pasteGate('We are hiring a .NET developer. Visit our careers page.', cfg())
  assert.equal(g.ok, false)
  if (!g.ok) {
    assert.deepEqual(g.found.emails, [])
    assert.deepEqual(g.enabled, ['email'])
  }
})

test('pasteGate keys on the text alone, so the same paste twice is one key', () => {
  const a = pasteGate(POST, cfg())
  const b = pasteGate(POST, cfg())
  // Prepended, not appended: dedupeKey hashes only the first 160 chars (keyText in scraper/lib.ts) and
  // POST collapses to 231, so appending past that window left the hash unchanged (measured).
  const c = pasteGate('Extra line. ' + POST, cfg())
  assert.equal(a.ok && b.ok && a.key === b.key, true)
  assert.equal(a.ok && c.ok && a.key !== c.key, true)
})

test('pasteRecord marks its origin and leaves every LinkedIn field null', () => {
  const g = pasteGate(POST, cfg())
  assert.equal(g.ok, true)
  if (!g.ok) return
  const rec = pasteRecord(POST, cfg(), g, {
    post_type: 'hiring', title: 'Senior .NET Developer', company: 'Example Ltd',
    location: 'Remote', is_remote: true, is_in_scope: true, score: 7, reason: 'matches the stack'
  })
  assert.equal(rec.searchTerm, PASTED_TERM)
  assert.equal(rec.author, null)
  assert.equal(rec.authorUrl, null)
  assert.equal(rec.postUrl, null)
  assert.equal(rec.postedAge, null)
  assert.equal(rec.postedAt, null)
  assert.equal(rec.score, 7)
  assert.equal(rec.postType, 'hiring')
  assert.equal(rec.remote, true)
  assert.equal(rec.text, POST)
  assert.deepEqual(rec.emails, ['recruiter@example.com'])
})

test('pasteRecord carries the owner\'s exclude flags', () => {
  const g = pasteGate(POST, cfg({ excludes: ['micro1.ai', 'Example Ltd'] }))
  assert.equal(g.ok, true)
  if (!g.ok) return
  const rec = pasteRecord(POST, cfg({ excludes: ['.NET Core'] }), g, {
    post_type: 'hiring', title: 't', company: 'c', location: 'l',
    is_remote: false, is_in_scope: false, score: 6, reason: 'r'
  })
  assert.ok(rec.flags.includes('excluded'), 'an exclude needle in pasted text must flag the row')
})

// jobs.ts cannot be imported by a test — it pulls in the drafter, Gmail and Nitro's auto-imports — so
// the lane wiring is checked over the source, the way every other jobs.ts guard in this suite is.
test('a paste runs on its own lane, never behind a scrape or a draft', () => {
  const src = readFileSync('server/utils/jobs.ts', 'utf8')
  assert.match(src, /export type Lane = 'scrape' \| 'draft' \| 'paste'/)
  assert.match(src, /kind === 'paste'\s*\n?\s*\?\s*'paste'/, 'laneOf must map paste to its own lane')
  assert.match(src, /paste: \{ current: null, last: null \}/, 'the lanes initialiser must carry paste')
  assert.match(src, /state\.lanes\.paste \?\?=/, 'a dev server holding pre-paste state must be upgraded')
  assert.match(src, /paste: \{ current: jobView\(lanes\.paste\.current\)/, 'stateView must expose the lane')
  // Anchored to the busy() definition itself: a bare /lanes\.paste\.current/ is also satisfied by
  // stateView()'s unrelated jobView(lanes.paste.current) and would stay green through this exact bug.
  assert.match(
    src,
    /busy = \(\) => !!\(lanes\.scrape\.current \|\| lanes\.draft\.current \|\| lanes\.paste\.current\)/,
    'busy() must count the paste lane'
  )
})

test('the paste job never writes a row it could not score', () => {
  // scorePost throwing must propagate to runJob's catch, not fall through to applyRecord with a
  // half-built record — the same posture as a scraped post whose score fails.
  //
  // These are source-text assertions over a file no test can import (see the comment at the top of
  // this suite), so they cannot prove the absence of every possible fallback. They catch the shapes
  // this regression realistically takes — an insert nested textually inside a catch, or the score
  // call itself wrapped in a try that swallows and substitutes — not every way a determined rewrite
  // could route a fabricated score into applyRecord.
  const src = readFileSync('server/utils/paste-job.ts', 'utf8')
  const body = src.slice(src.indexOf('export async function runPasteJob'))
  const iScore = body.indexOf('await scorePost(')
  const iApply = body.indexOf('applyRecord(')
  assert.ok(iScore > 0, 'runPasteJob must call scorePost')
  assert.ok(iApply > 0, 'runPasteJob must call applyRecord')
  assert.ok(iScore < iApply, 'the score must be awaited before the insert')
  assert.doesNotMatch(body, /catch\s*\{[^}]*applyRecord/s, 'a failed score must not still insert')
  assert.doesNotMatch(
    body,
    /try\s*\{[^}]*await scorePost/s,
    'scorePost must not be wrapped in a try — a failed score has to propagate, not fall through to a fabricated one'
  )
})
