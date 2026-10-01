// Bulk Draft runs "screened": the drafter may skip, and the skip is recorded. persist() does not guard
// against rewriting a `drafted` verdict as `skipped` (CLAUDE.md, "A skip must never downgrade a drafted
// verdict"); the batch queue never reaches that because it selects `a.key IS NULL`, so the screened
// keyed path must select the same way. This file pins that.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import { freshKeys, keyedDraftRows } from '../server/utils/draft-rows.ts'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'

let dir: string
let db: Database.Database
const K = (c: string) => c.repeat(40)

const post = (key: string): ScraperRecord => ({
  op: 'post',
  key,
  searchTerm: 't',
  author: 'R',
  authorUrl: 'https://www.linkedin.com/in/r',
  postUrl: null,
  postedAge: '1d',
  postedAt: '2026-09-30T09:00:00.000Z',
  postType: 'hiring',
  title: 'Engineer',
  company: 'Acme',
  location: 'Riyadh',
  remote: false,
  inScope: true,
  emails: ['hr@acme.sa'],
  links: [],
  phones: [],
  refIds: [],
  channels: ['email'],
  score: 7,
  reason: 'r',
  text: 'hiring, send CV to hr@acme.sa',
  flags: []
} as ScraperRecord)

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-draftrows-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
  for (const c of ['a', 'b', 'c', 'd']) applyRecord(db, post(K(c)))
  // e-i: unprocessed, but each fails one batch-queue predicate
  applyRecord(db, { ...post(K('e')), flags: ['excluded'] } as ScraperRecord)
  applyRecord(db, { ...post(K('f')), score: 5 } as ScraperRecord)
  applyRecord(db, { ...post(K('g')), postType: 'seeking' } as ScraperRecord)
  applyRecord(db, { ...post(K('h')), emails: [], channels: ['link'], links: ['https://lnkd.in/x'] } as ScraperRecord)
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'drafted', 'named in application')`).run(K('b'))
  db.prepare(`INSERT INTO applications (key, verdict, reason) VALUES (?, 'skipped', 'not hiring')`).run(K('c'))
  db.prepare('UPDATE posts SET dismissed_at = unixepoch() WHERE key = ?').run(K('d'))
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

const keysOf = (rows: unknown[]) => (rows as { key: string }[]).map(r => r.key).sort()

test('screened: only posts with no verdict — drafted and skipped rows are left alone', () => {
  assert.deepEqual(keysOf(keyedDraftRows(db, [K('a'), K('b'), K('c'), K('d')], true)), [K('a')])
})

test('control: hand-picked (the row button) still reaches a skipped post, so it can be overruled', () => {
  assert.deepEqual(keysOf(keyedDraftRows(db, [K('a'), K('b'), K('c'), K('d')], false)), [K('a'), K('b'), K('c')])
})

test('dismissed posts are never drafted, in either mode', () => {
  assert.deepEqual(keysOf(keyedDraftRows(db, [K('d')], false)), [])
})

test('freshKeys drops keys already queued (single or bulk) or running', () => {
  assert.deepEqual(
    freshKeys([K('a'), K('b'), K('c'), K('d')], [{ key: K('a') }, { keys: [K('b')] }], [K('c')]),
    [K('d')]
  )
})

test('screened takes the batch-queue predicates too: excluded, flagged, low-score, not hiring, no address', () => {
  // The exclude list is a promise the batch queue keeps (CLAUDE.md, posts.flags); bulk Draft is
  // "screened like the batch run", so it keeps it as well — selecting under Flags: Excluded must not draft.
  assert.deepEqual(keysOf(keyedDraftRows(db, ['a', 'e', 'f', 'g', 'h'].map(K), true)), [K('a')])
})

test('control: hand-picked still reaches them — the row Draft button is the owner overruling the screen', () => {
  assert.deepEqual(keysOf(keyedDraftRows(db, ['e', 'f', 'g'].map(K), false)), ['e', 'f', 'g'].map(K))
})
