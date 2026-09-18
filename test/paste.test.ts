import assert from 'node:assert/strict'
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
