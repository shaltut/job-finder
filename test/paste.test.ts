import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadCv, scorePost } from '../scraper/score.ts'
import { emptySettings } from '../shared/settings.ts'
import { PASTED_TERM, pasteGate, pasteOnce, pasteRecord } from '../server/utils/paste.ts'

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
  // the Lane union moved to queue-core.ts with the gaps lane (2026-10-03); jobs.ts re-exports it
  assert.match(readFileSync('server/utils/queue-core.ts', 'utf8'), /export type Lane = 'scrape' \| 'draft' \| 'paste' \| 'gaps'/)
  assert.match(src, /export type \{ Lane \}/)
  assert.match(src, /kind === 'paste'\s*\n?\s*\?\s*'paste'/, 'laneOf must map paste to its own lane')
  assert.match(src, /paste: \{ current: null, last: null \}/, 'the lanes initialiser must carry paste')
  assert.match(src, /state\.lanes\.paste \?\?=/, 'a dev server holding pre-paste state must be upgraded')
  assert.match(src, /paste: \{ current: jobView\(lanes\.paste\.current\)/, 'stateView must expose the lane')
  // Anchored to the busy() definition itself: a bare /lanes\.paste\.current/ is also satisfied by
  // stateView()'s unrelated jobView(lanes.paste.current) and would stay green through this exact bug.
  assert.match(
    src,
    /busy = \(\) => !!\(lanes\.scrape\.current \|\| lanes\.draft\.current \|\| lanes\.paste\.current \|\| lanes\.gaps\.current\)/,
    'busy() must count the paste lane'
  )
})

test('a paste whose scoring fails stores nothing', async () => {
  // Behavioural, not textual: this held against a try/catch fallback and then against a .catch()
  // fallback, each of which passed the previous round's source-text regex over paste-job.ts in turn.
  // Injecting the dependencies instead means the property survives whatever spelling comes next.
  let stored = 0
  await assert.rejects(
    () => pasteOnce(POST, cfg(), {
      system: async () => 'a system prompt',
      score: async () => { throw new Error('openai exploded') },
      store: () => {
        stored++
        return true
      }
    }, () => {}),
    /openai exploded/
  )
  assert.equal(stored, 0, 'a failed score must never reach the insert')
  // Edges a runtime test on pasteOnce alone cannot see, all about the wiring in paste-job.ts rather
  // than pasteOnce itself: that runPasteJob actually delegates instead of reimplementing the same
  // logic inline (where the property just proven would no longer hold for the code that runs), that
  // scorePost is injected bare rather than wrapped in something that absorbs its own failure, and —
  // generalising that last one rather than adding a third per-binding pin for whichever dependency
  // grows a wrapper next — that runPasteJob's whole body absorbs nothing at all. `catch` and `.then(`
  // are the two ways a promise failure gets swallowed; a bare `score: myWrapper` would slip past
  // both of those but still gets caught by the scorePost-must-be-bare pin above, and a `.then(` on
  // some other dependency would slip past that pin but not this one — neither assertion subsumes
  // the other, so both stay.
  const wiring = readFileSync('server/utils/paste-job.ts', 'utf8')
  assert.match(wiring, /return pasteOnce\(/, 'runPasteJob must delegate to pasteOnce, or the test above guards nothing that runs')
  assert.match(
    wiring,
    /score: scorePost,/,
    'scorePost must be injected bare — wrapping it here absorbs a failure before pasteOnce can see it'
  )
  // Scoped to runPasteJob's body, not the whole file: cvSystem above it may legitimately contain
  // neither token, and a whole-file search would mean nothing here either. Anchor checked before the
  // slice, and the "no export after this one" check below bounds the other end explicitly rather than
  // assuming runPasteJob stays last — the same shape as the enqueue() assertion further down. Without
  // the anchor check, an unchecked indexOf would make slice(-1) grab the file's last byte and this
  // assertion would then pass vacuously over that one character the moment the anchor stopped matching.
  const runPasteJobStart = wiring.indexOf('export async function runPasteJob')
  assert.ok(runPasteJobStart > -1, 'runPasteJob must still be exported from paste-job.ts')
  assert.equal(
    wiring.indexOf('\nexport ', runPasteJobStart + 1),
    -1,
    'runPasteJob must stay the last export in paste-job.ts, or this slice needs an end bound'
  )
  const body = wiring.slice(runPasteJobStart, wiring.length)
  assert.doesNotMatch(
    body,
    /\bcatch\b|\.then\(/,
    'the wiring must absorb nothing: every failure belongs to runJob, which logs it and leaves the post to be pasted again'
  )
})

test('the paste endpoint refuses before it queues, and never leaks the whole post back', () => {
  const src = readFileSync('server/api/posts/paste.post.ts', 'utf8')
  // Anchored to the assignment itself, not a bare substring: the file's own docstring says
  // "The strict readConfig() is deliberate", so a bare /readConfig\(\)/ would match that prose even
  // if the functional call underneath it were swapped for a non-throwing read (measured: both lines
  // contain the literal text "readConfig()").
  assert.match(src, /config = readConfig\(\)/, 'the endpoint must call the throwing readConfig() to build config')
  // Both indices checked for -1 before comparing: an unchecked `indexOf(a) < indexOf(b)` passes
  // vacuously the moment pasteGate(...) is removed from the file, since -1 < n for any real position.
  const gateIdx = src.indexOf('pasteGate(')
  const enqueueIdx = src.indexOf('enqueue(')
  assert.ok(gateIdx > -1, 'pasteGate(...) must be called in the endpoint')
  assert.ok(enqueueIdx > -1, 'enqueue(...) must be called in the endpoint')
  assert.ok(gateIdx < enqueueIdx, 'the gate must run before the enqueue')
  // Counts, not addresses: the refusal is rendered in a browser and the address is a third party's.
  assert.match(src, /emails: gate\.found\.emails\.length/, 'the refusal must report counts')
  assert.doesNotMatch(src, /found: gate\.found\s*[,}]/, 'never hand the extracted values back')
})

// jobs.ts cannot be imported here either (see the lane-wiring test above), so this is source-text
// too. The endpoint's duplicate check only covers a post already scored and stored — a second paste
// of the same text while the first is still queued or being scored would otherwise burn a second
// OpenAI call before ON CONFLICT DO NOTHING throws it away, since enqueue() had no arm for 'paste'
// the way it already did for 'draft' and 'sync'.
test('enqueue() suppresses a duplicate paste, not just a duplicate draft or sync', () => {
  const src = readFileSync('server/utils/jobs.ts', 'utf8')
  const start = src.indexOf('export function enqueue')
  // Anchor checked before the slice, and the slice bounded at both ends: an unbounded or
  // silently-empty slice would let the assertion below match nothing and still report a "pass".
  assert.ok(start > -1, 'enqueue must still be exported from jobs.ts')
  const end = src.indexOf('\nfunction pump', start)
  assert.ok(end > start, 'enqueue must still be immediately followed by pump(), or this slice is unbounded')
  const body = src.slice(start, end)
  assert.match(
    body,
    /if \(kind === 'paste' && args\.text\s*\n\s*&& \(queue\.some\(q => q\.args\.text === args\.text\) \|\| lanes\.paste\.current\?\.args\?\.text === args\.text\)\) return null/,
    'a pasted text already queued, or the text of the paste currently running, must be a no-op'
  )
})
