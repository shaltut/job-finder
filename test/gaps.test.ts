// The gap record: what each application post asks for, judged against the master CV. These tests run
// against a real migrated database with the model call injected, so nothing here touches OpenAI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'
import {
  aggregateGaps, applicationCounts, extractGaps, pendingApplications, requirementRows, storeRun,
  verifyRequirements, type GapRow, type RawRequirement
} from '../server/utils/gaps.ts'
import { keywordList, modeStatus, type GapTerm } from '../shared/gaps.ts'

let dir: string
let db: Database.Database

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-gaps-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A distinct 40-character key per test, so tests sharing one database never see each other's rows. */
const k = (n: number) => String(n).padStart(40, '0')

const POST = 'Senior Backend Engineer. Requirements: 5+ years of Kubernetes in production; strong PostgreSQL '
  + 'query tuning. Nice to have: experience with Terraform modules.'

const addPost = (key: string, text = POST) => applyRecord(db, {
  op: 'post', key, searchTerm: 'x', author: 'A', authorUrl: 'https://www.linkedin.com/in/a', postUrl: null,
  postedAge: '1h', postedAt: '2026-09-21T09:00:00.000Z', postType: 'hiring', title: 'Senior Backend Engineer',
  company: 'Acme', location: null, remote: true, inScope: true, emails: ['hr@example.com'], links: [], phones: [],
  refIds: [], channels: ['email'], score: 7, reason: '', text, flags: []
} as ScraperRecord)

const count = (table: string, key: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE key = ?`).get(key) as { n: number }).n

test('both tables exist, and deleting a post deletes its requirements and its run', () => {
  const key = k(1)
  addPost(key)
  db.prepare(`INSERT INTO post_requirements (key, term, category, importance, status, quote, cv_shows)
    VALUES (?, 'Kubernetes', 'technology', 'must', 'absent', '5+ years of Kubernetes', '')`).run(key)
  db.prepare(`INSERT INTO requirement_runs (key, cv_sha, model, kept, dropped) VALUES (?, 'sha', 'm', 1, 0)`).run(key)
  assert.equal(count('post_requirements', key), 1)
  assert.equal(count('requirement_runs', key), 1)

  db.prepare('DELETE FROM posts WHERE key = ?').run(key)

  assert.equal(count('post_requirements', key), 0, 'requirements cascade with the post')
  assert.equal(count('requirement_runs', key), 0, 'the run cascades with the post')
})

const CV = 'Led the migration to PostgreSQL, including query tuning with pg_stat_statements.\n'
  + 'Deployed services with Argo CD on Kubernetes clusters.'

const req = (over: Partial<RawRequirement> = {}): RawRequirement => ({
  term: 'Kubernetes',
  category: 'technology',
  importance: 'must',
  quote: '5+ years of Kubernetes in production',
  status: 'partial',
  cvShows: 'Argo CD on Kubernetes clusters',
  ...over
})

test('a requirement survives only when its quote is in the post', () => {
  const invented = req({ term: 'Go', quote: '3 years of Go microservices', status: 'absent', cvShows: '' })
  const { kept, dropped } = verifyRequirements([req(), invented], POST, CV)
  assert.deepEqual(kept.map(r => r.term), ['Kubernetes'])
  assert.deepEqual(dropped.map(d => d.why), ['quote not found in the post'])
})

test('whitespace, case and punctuation do not break a quote match', () => {
  const { kept } = verifyRequirements([req({ quote: '5+  YEARS of kubernetes, in production' })], POST, CV)
  assert.equal(kept.length, 1)
})

test('a short quote must appear as a whole word, so a one-word bullet survives and "Go" in "Google" does not', () => {
  // Posts list requirements as bare bullets, and the model quotes the bullet. Compared on letters and
  // digits alone, "go" is inside "google", "going" and "ago" — so below MIN_QUOTE it is a whole-word match.
  const post = `${POST}\n- React\n- AWS\nWe use Google Workspace.`
  const { kept, dropped } = verifyRequirements([
    req({ term: 'React', quote: 'React', status: 'absent', cvShows: '' }),
    req({ term: 'AWS', quote: 'AWS', status: 'absent', cvShows: '' }),
    req({ term: 'Go', quote: 'Go', status: 'absent', cvShows: '' })
  ], post, CV)
  assert.deepEqual(kept.map(r => r.term), ['React', 'AWS'])
  assert.deepEqual(dropped.map(d => d.why), ['quote not found in the post'])
})

test('a one-word CV quote counts when the CV names the skill on its own', () => {
  // the master CV lists skills one per line, so "Redis" is a complete, honest CV quote
  const post = `${POST}\n- Redis\n- C#\n- Go`
  const cv = `${CV}\nRedis\nC#\nGoogle Cloud`
  const { kept, dropped } = verifyRequirements([
    req({ term: 'Redis', quote: 'Redis', status: 'present', cvShows: 'Redis' }),
    req({ term: 'C#', quote: 'C#', status: 'present', cvShows: 'C#' }),
    req({ term: 'Go', quote: 'Go', status: 'present', cvShows: 'Go' })
  ], post, cv)
  assert.deepEqual(kept.map(r => r.term), ['Redis', 'C#'])
  assert.deepEqual(dropped.map(d => d.why), ['CV quote not found in the CV'])
})

test('present and partial must quote the CV, and absent must not', () => {
  const rows = [
    req({ term: 'A', status: 'present', cvShows: '' }),
    req({ term: 'B', status: 'partial', cvShows: 'ten years of Kubernetes operations' }),
    req({ term: 'C', status: 'absent', cvShows: 'Argo CD on Kubernetes clusters' }),
    req({ term: 'Terraform', status: 'absent', cvShows: '', quote: 'experience with Terraform modules', importance: 'nice' })
  ]
  const { kept, dropped } = verifyRequirements(rows, POST, CV)
  assert.deepEqual(kept.map(r => r.term), ['Terraform'], 'only the honest absence survives')
  assert.deepEqual(dropped.map(d => d.why), [
    'present with no CV quote',
    'CV quote not found in the CV',
    'marked absent but quotes the CV'
  ])
  assert.equal(kept[0]!.cvShows, '', 'an absence stores no CV quote')
})

test('the same term twice on one post is kept once, case-insensitively', () => {
  const { kept, dropped } = verifyRequirements([req(), req({ term: 'kubernetes ' })], POST, CV)
  assert.equal(kept.length, 1)
  assert.deepEqual(dropped.map(d => d.why), ['duplicate term'])
})

test('an empty term is dropped and a long one is capped', () => {
  const { kept, dropped } = verifyRequirements([req({ term: '  ' }), req({ term: 'K'.repeat(80) })], POST, CV)
  assert.deepEqual(dropped.map(d => d.why), ['no term'])
  assert.equal(kept[0]!.term.length, 60)
})

const draft = (key: string) =>
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'drafted', 'named in application')`).run(key)
const skip = (key: string) =>
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'skipped', 'outside the field')`).run(key)
const applyByHand = (key: string) => db.prepare('UPDATE posts SET applied_at = unixepoch() WHERE key = ?').run(key)
const pendingOf = (sha: string, mine: string[]) =>
  pendingApplications(db, sha).map(p => p.key).filter(key => mine.includes(key)).sort()

test('an application is a drafted post or one applied to by hand, and nothing else', () => {
  const [drafted, applied, skipped, untouched] = [k(10), k(11), k(12), k(13)]
  for (const key of [drafted, applied, skipped, untouched]) addPost(key)
  draft(drafted)
  applyByHand(applied)
  skip(skipped)
  assert.deepEqual(pendingOf('sha-1', [drafted, applied, skipped, untouched]), [drafted, applied])
})

test('a post read against this CV is done, and a new CV makes it pending again', () => {
  const key = k(20)
  addPost(key)
  draft(key)
  storeRun(db, key, [], { cvSha: 'sha-1', model: 'm', dropped: 0 })
  assert.deepEqual(pendingOf('sha-1', [key]), [], 'read against the current CV: done, even with no rows')
  assert.deepEqual(pendingOf('sha-2', [key]), [key], 'a different CV makes it stale')
})

test('a run after a draft reads only the posts it names, never the stale backlog', () => {
  const [justDrafted, stale] = [k(25), k(26)]
  for (const key of [justDrafted, stale]) { addPost(key); draft(key) }
  const keyed = (keys: string[]) => pendingApplications(db, 'sha-1', keys).map(p => p.key)
  assert.deepEqual(keyed([justDrafted]), [justDrafted], 'the other pending application is left alone')
  assert.deepEqual(keyed([]), [], 'an empty key list reads nothing, not everything')
  assert.ok(pendingOf('sha-1', [justDrafted, stale]).length === 2, 'no keys is still the full backfill')
})

test('a re-run replaces the post\'s rows and its run, never mixing old and new', () => {
  const key = k(30)
  addPost(key)
  draft(key)
  storeRun(db, key, [req({ term: 'A' }), req({ term: 'B' })], { cvSha: 'sha-1', model: 'm', dropped: 2 })
  storeRun(db, key, [req({ term: 'C' })], { cvSha: 'sha-2', model: 'm2', dropped: 0 })
  const terms = db.prepare('SELECT term FROM post_requirements WHERE key = ? ORDER BY term').all(key) as { term: string }[]
  assert.deepEqual(terms.map(t => t.term), ['C'])
  const run = db.prepare('SELECT cv_sha, model, kept, dropped FROM requirement_runs WHERE key = ?').get(key)
  assert.deepEqual(run, { cv_sha: 'sha-2', model: 'm2', kept: 1, dropped: 0 })
})

test('the loop stores what verifies, leaves a failed call pending, and says so', async () => {
  const [ok, broken, empty] = [k(40), k(41), k(42)]
  // distinct text per post, so the fake model below can tell them apart
  addPost(ok)
  addPost(broken, `${POST} BROKEN`)
  addPost(empty, `${POST} EMPTY`)
  for (const key of [ok, broken, empty]) draft(key)
  const log: string[] = []
  const invented = req({ term: 'Go', quote: '3 years of Go microservices', status: 'absent', cvShows: '' })
  const res = await extractGaps(db, {
    cvText: CV,
    cvSha: 'sha-loop',
    model: 'fake',
    ask: async (text) => {
      if (text.includes('BROKEN')) throw new Error('rate limited')
      if (text.includes('EMPTY')) return []
      return [req(), invented]
    }
  }, line => log.push(line))

  // the fixture posts from earlier tests are pending under this sha too, so compare only ours
  assert.equal(count('post_requirements', ok), 1, 'the verified row is stored, the invented one is not')
  assert.equal(count('requirement_runs', broken), 0, 'a failed call writes nothing, so it is retried next run')
  assert.equal(count('requirement_runs', empty), 1, 'an empty table is still a completed read')
  assert.ok(res.stored < res.pending, 'the failure is visible in the counts')
  assert.ok(log.some(l => l.includes('rate limited') && l.includes('left for the next run')))
  assert.ok(log.some(l => l.includes('no requirements at all') && l.includes('JOBFINDER_GAPS_MODEL')))
  assert.ok(log.some(l => l.includes('quote not found in the post')), 'drops are reported with their reason')
})

test('Stop is honoured between posts', async () => {
  const key = k(50)
  addPost(key)
  draft(key)
  const abort = new AbortController()
  abort.abort()
  const log: string[] = []
  const res = await extractGaps(db, { cvText: CV, cvSha: 'sha-stop', model: 'fake', ask: async () => [req()] },
    line => log.push(line), abort.signal)
  assert.equal(res.stored, 0)
  assert.ok(log.includes('stopped'))
})

test('the most frequent status wins, and a tie goes to the worse one', () => {
  assert.equal(modeStatus(['present', 'present', 'absent']), 'present')
  assert.equal(modeStatus(['present', 'absent']), 'absent', 'a split verdict never hides a gap')
  assert.equal(modeStatus(['partial', 'present']), 'partial')
  assert.equal(modeStatus(['partial', 'absent', 'partial']), 'partial')
})

const row = (over: Partial<GapRow>): GapRow => ({
  key: k(900), term: 'React', category: 'technology', importance: 'must', status: 'absent',
  quote: 'q', cvShows: '', title: 'T', company: 'C', postUrl: null, appliedAt: 1_758_441_600, ...over
})

test('grouping: absent is Learn; otherwise On your CV when the CV names it on whole words, else Add now', () => {
  const cv = 'Built APIs in C# on .NET 8, deployed on Google Cloud.'
  const terms = aggregateGaps([
    row({ term: 'React', status: 'absent' }),
    row({ term: 'C#', status: 'present' }),
    row({ term: '.NET', status: 'partial' }),
    row({ term: 'Go', status: 'partial' }) // "Google" must not count as Go
  ], cv)
  const group = Object.fromEntries(terms.map(t => [t.term, t.group]))
  assert.deepEqual(group, { 'React': 'learn', 'C#': 'on-cv', '.NET': 'on-cv', 'Go': 'add' })
})

test('terms group case-insensitively and rank by applications, then must-haves', () => {
  const terms = aggregateGaps([
    row({ key: k(901), term: 'Kafka' }),
    row({ key: k(902), term: 'kafka', importance: 'nice' }),
    row({ key: k(903), term: 'Terraform' }),
    row({ key: k(904), term: 'Rust', importance: 'nice' }),
    row({ key: k(905), term: 'Rust', importance: 'nice' })
  ], '')
  assert.deepEqual(terms.map(t => [t.term, t.applications, t.must]), [
    ['Kafka', 2, 1], ['Rust', 2, 0], ['Terraform', 1, 1]
  ])
  assert.equal(terms[0]!.posts.length, 2, 'every application behind the term is listed')
  assert.equal(terms[0]!.lastSeen, new Date(1_758_441_600_000).toISOString())
})

test('the copyable list has Add now, then Learn, leaves out what is already on the CV, and flags a partial term', () => {
  const t = (term: string, group: GapTerm['group'], applications: number, must: number, status: GapTerm['status'] = 'present'): GapTerm =>
    ({ term, category: 'technology', group, status, applications, must, lastSeen: null, posts: [] })
  assert.equal(keywordList([
    t('React', 'learn', 12, 8, 'absent'),
    t('GitOps', 'add', 7, 5, 'partial'),
    t('C#', 'on-cv', 20, 20),
    t('Rust', 'learn', 1, 0, 'absent')
  ]),
  'Add now — your CV shows related experience; use the posts\' word where it is true\n'
  + '- GitOps — 7 applications (5 must-have) — partial: check the CV evidence first\n\n'
  + 'Learn — not on your CV yet\n'
  + '- React — 12 applications (8 must-have)\n'
  + '- Rust — 1 application (0 must-have)')
})

test('the page reads application rows only, and counts what was read against the current CV', () => {
  const [a, b, gone] = [k(60), k(61), k(62)]
  for (const key of [a, b, gone]) addPost(key)
  draft(a)
  applyByHand(b)
  skip(gone) // rows left behind by a post that is not an application must not be ranked
  storeRun(db, a, [req({ term: 'ZetaTerm' })], { cvSha: 'sha-page', model: 'm', dropped: 0 })
  storeRun(db, b, [req({ term: 'ZetaTerm' })], { cvSha: 'sha-old', model: 'm', dropped: 0 })
  storeRun(db, gone, [req({ term: 'ZetaTerm' })], { cvSha: 'sha-page', model: 'm', dropped: 0 })

  const zeta = requirementRows(db).filter(r => r.term === 'ZetaTerm').map(r => r.key).sort()
  assert.deepEqual(zeta, [a, b])
  const counts = applicationCounts(db, 'sha-page')
  assert.ok(counts.applications >= 2)
  assert.ok(counts.analysed < counts.applications, 'b was read against an older CV, so it is not counted')
})

test('applications are read several at a time, never more than the limit', async () => {
  const keys = [k(80), k(81), k(82), k(83), k(84), k(85)]
  for (const key of keys) {
    addPost(key, `${POST} PAR-${key}`)
    draft(key)
  }
  let inFlight = 0
  let peak = 0
  const res = await extractGaps(db, {
    cvText: CV, cvSha: 'sha-par', model: 'fake', concurrency: 3,
    ask: async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 10))
      inFlight--
      return [req()]
    }
  }, () => {}, undefined, keys)
  assert.equal(res.stored, 6)
  assert.equal(peak, 3)
})
