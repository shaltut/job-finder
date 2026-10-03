// Pressing Draft on a single post in the Posts view is the owner overruling the model's fit screen.
// The model still returns `skipped` sometimes — it follows a written instruction most of the time, and
// "most of the time" is the failure — so the promise that a chosen post is never recorded as skipped
// lives here, in code, beside gateOnPostType() and PLACEHOLDER.
//
// Why it matters enough to test rather than comment: an `applications` row of either verdict takes the
// post out of the batch queue for good (`a.key IS NULL`), so a persisted skip on a hand-picked post is
// no email AND no way back. Measured on the 2026-09-17 backup: three posts skipped on fit at scores
// 5-6, each one the owner would have overruled.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'
import { persist } from '../server/utils/drafts.ts'
import type { DraftRequest, DraftResponse } from '../server/utils/drafter.ts'
import { sentTo } from '../shared/recruiter-stage.ts'

let dir: string
let db: Database.Database

const post = (key: string): ScraperRecord => ({
  op: 'post',
  key,
  searchTerm: 'senior frontend developer',
  author: 'A Recruiter',
  authorUrl: 'https://www.linkedin.com/in/recruiter',
  postUrl: null,
  postedAge: '3h',
  postedAt: '2026-09-17T09:00:00.000Z',
  postType: 'hiring',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: 'Riyadh',
  remote: true,
  inScope: true,
  emails: ['hr@acme.sa'],
  links: [],
  phones: [],
  refIds: [],
  channels: ['email'],
  score: 6,
  reason: 'Match: some',
  text: 'We are hiring. Send CV to hr@acme.sa',
  flags: []
} as ScraperRecord)

const request = (key: string, chosen: boolean): DraftRequest => ({
  mode: 'apply',
  chosen,
  recruiterEmail: 'hr@acme.sa',
  posts: [{ key, title: 'Senior Frontend Engineer', company: 'Acme', location: 'Riyadh', score: 6, postType: 'hiring', flags: [], text: 'hiring' }]
})

const skipped = (key: string): DraftResponse => ({
  results: [{ key, verdict: 'skipped', reason: 'a must-have the Gaps say the candidate lacks' }],
  report: ''
})

const rowsFor = (key: string) =>
  db.prepare('SELECT verdict, reason FROM applications WHERE key = ?').all(key) as { verdict: string, reason: string }[]

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-manual-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a post the owner chose by hand is never recorded as skipped', () => {
  const key = 'a'.repeat(40)
  applyRecord(db, post(key))

  const { drafted, skipped: count } = persist(db, request(key, true), skipped(key), null)

  assert.deepEqual(rowsFor(key), [], 'a chosen post must keep no applications row, or it leaves the batch queue for good')
  assert.equal(drafted, 0)
  assert.equal(count, 1, 'still counted, so the job log line stays honest about what happened')
})

test('a bulk skip is still recorded — this is the triage queue and must not be emptied', () => {
  // The control. Without it, the guard above could quietly stop the bulk run writing any verdict at
  // all, and every post would be re-drafted on every run.
  const key = 'b'.repeat(40)
  applyRecord(db, post(key))

  persist(db, request(key, false), skipped(key), null)

  const rows = rowsFor(key)
  assert.equal(rows.length, 1, 'the bulk path records the model\'s verdict exactly as before')
  assert.equal(rows[0]!.verdict, 'skipped')
  assert.match(rows[0]!.reason, /must-have/, 'with the reason the owner reads when reviewing')
})

test('choosing a post does not stop a real draft being recorded', () => {
  // The guard is on the skipped verdict alone: a chosen post that IS drafted must still get its row,
  // its `named in application` prefix and its contacts upsert, or the follow-up would name it twice.
  const key = 'c'.repeat(40)
  applyRecord(db, post(key))

  const res: DraftResponse = {
    results: [{ key, verdict: 'drafted', reason: 'named in application to hr@acme.sa', subject: 'Senior Frontend Engineer', body: 'Dear team, ...' }],
    report: ''
  }
  persist(db, request(key, true), res, 'data/drafts/x.json')

  const rows = rowsFor(key)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.verdict, 'drafted')
  assert.match(rows[0]!.reason, /^named in application/, 'the prefix the follow-up query depends on')
  const contact = db.prepare('SELECT stage FROM contacts WHERE email = ?').get('hr@acme.sa') as { stage: string } | undefined
  assert.equal(contact?.stage, 'drafted', 'a real email still moves the recruiter\'s stage')
})

test('the recovery path: a bulk skip is upgraded when the owner overrules it', () => {
  // The transition the whole change exists for. A post the bulk run passed over carries a `skipped`
  // row; pressing Draft in the Posts view and getting an email must replace it, prefix and all, so the
  // follow-up knows the role is covered and does not name it a second time.
  const key = 'd'.repeat(40)
  applyRecord(db, post(key))
  persist(db, request(key, false), skipped(key), null)
  assert.equal(rowsFor(key)[0]!.verdict, 'skipped', 'the bulk run passed it over first')

  const res: DraftResponse = {
    results: [{ key, verdict: 'drafted', reason: 'named in application to hr@acme.sa', subject: 'Role', body: 'Dear team, ...' }],
    report: ''
  }
  persist(db, request(key, true), res, 'data/drafts/y.json')

  const rows = rowsFor(key)
  assert.equal(rows.length, 1, 'still one row per post')
  assert.equal(rows[0]!.verdict, 'drafted', 'the owner overruled the skip and the row follows')
  assert.match(rows[0]!.reason, /^named in application/, 'the old skip reason must not survive the upgrade')
})

test('the Gmail gate writes no row for a chosen post either', () => {
  // Source-level, because this branch lives inside runDraftJob, which needs a spawned claude session.
  // A closed recruiter is still a refusal when the owner chose the post — the two-emails ceiling is
  // not a fit judgement — but it must not bury the post, since the follow-up carries the role instead.
  const jobs = readFileSync('server/utils/jobs.ts', 'utf8')
  const gate = jobs.slice(jobs.indexOf('if (closed) {'), jobs.indexOf('const cc = ccFrom'))
  // !manual, and since 2026-10-03 also !args.resumed (a draft resumed after a restart — queue-core resumedArgs)
  assert.match(gate, /const writeSkips = !manual && !args\.resumed/, 'the closed-recruiter skip insert must be guarded by !manual')
  assert.ok(
    gate.indexOf('if (writeSkips) {') >= 0 && gate.indexOf('if (writeSkips) {') < gate.indexOf('INSERT INTO applications'),
    'the guard must come before the insert, not after it'
  )
  assert.match(
    jobs,
    /const manual = !!args\.keys\?\.length/,
    'manual mode is derived from the single-post keys, which is what pump() preserves'
  )
})

test('the Draft button hides on a recruiter Gmail has mail for, and never on a pending draft', () => {
  // Hiding it on `drafted` is the silent failure: a Gmail draft deleted unsent reopens the recruiter,
  // and a hidden button would leave nothing but curl able to reach the gate that can see that.
  assert.equal(sentTo(null), false, 'a recruiter never written to keeps the button')
  assert.equal(sentTo('drafted'), false, 'a pending draft can be deleted unsent, so only the gate can tell')
  for (const s of ['contacted', 'followed_up', 'replied', 'final'] as const) {
    assert.equal(sentTo(s), true, `${s}: the gate can only refuse, so the button would be noise`)
  }
})

test('the Posts view keeps the Draft button on a skipped post', () => {
  // The whole of what buried a skipped post: 'skipped' is as truthy as 'drafted', so gating the button
  // on `r.verdict` hid the one control that could overrule the model. CLAUDE.md has described
  // re-drafting from the Posts view as the recovery path since M3; this is what makes it true.
  const page = readFileSync('app/pages/index.vue', 'utf8')
  const gate = page.slice(page.indexOf('r.dismissedAt || r.appliedAt'), page.indexOf('label: \'Draft\''))
  assert.match(gate, /r\.verdict === 'drafted'/, 'the Draft button must hide on drafted only, never on skipped')
  assert.doesNotMatch(gate, /\|\|\s*r\.verdict\s*\|\|/, 'a bare `r.verdict` here hides the button on skipped posts too')
  assert.match(gate, /sentTo\(r\.stage\)/, 'sentTo() is only tested above; this pins that the button actually uses it')
})

test('bulk Draft is screened, the row button is hand-picked — both halves of the split', () => {
  // Source-level, like the Gmail-gate test above: runDraftJob and the endpoint cannot be imported. The
  // older pin is a prefix match and passes whatever follows `args.keys?.length`; these pin the whole line.
  const jobs = readFileSync('server/utils/jobs.ts', 'utf8')
  assert.match(jobs, /const manual = !!args\.keys\?\.length && !args\.screened$/m,
    'a keyed job is hand-picked unless it carries `screened`')
  const endpoint = readFileSync('server/api/run/draft.post.ts', 'utf8')
  assert.match(endpoint, /a\.keys \? \{ keys: a\.keys, screened: true \}/,
    'a bulk selection ({ keys }) is always enqueued screened')
  assert.match(endpoint, /a\.key \? \{ key: a\.key \}/,
    'a single post ({ key }) is enqueued without `screened`, so it stays hand-picked')
})
