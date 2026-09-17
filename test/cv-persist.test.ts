// Which CV a recruiter was sent, recorded on contacts.cv_path. The follow-up reuses it, so a follow-up
// must never overwrite it, and an application that fell back to the uploaded PDF must record null
// rather than leave an earlier tailored path looking like what was sent.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import type { DraftRequest, DraftResponse } from '../server/utils/drafter.ts'
import { persist } from '../server/utils/drafts.ts'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'

let dir: string
let db: Database.Database
const KEY = 'c'.repeat(40)
const TAILORED = join('data', 'cv', 'tailored', 'hr_acme_sa', 'cv.pdf')

const post: ScraperRecord = {
  op: 'post',
  key: KEY,
  searchTerm: 'engineering manager',
  author: 'A Recruiter',
  authorUrl: 'https://www.linkedin.com/in/recruiter',
  postUrl: null,
  postedAge: '3h',
  postedAt: '2026-09-17T09:00:00.000Z',
  postType: 'hiring',
  title: 'Engineering Manager',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  inScope: true,
  emails: ['hr@acme.sa'],
  links: [],
  phones: [],
  refIds: [],
  channels: ['email'],
  score: 7,
  reason: 'Match: some',
  text: 'We are hiring. Send CV to hr@acme.sa',
  flags: []
} as ScraperRecord

const request = (mode: 'apply' | 'follow-up'): DraftRequest => ({
  mode,
  recruiterEmail: 'hr@acme.sa',
  posts: [{ key: KEY, title: 'Engineering Manager', company: 'Acme', location: 'Remote', score: 7, postType: 'hiring', flags: [], text: 'hiring' }]
})

const drafted = (mode: 'apply' | 'follow-up'): DraftResponse => ({
  results: [{
    key: KEY,
    verdict: 'drafted',
    reason: mode === 'apply' ? 'named in application; fit' : 'named in follow-up; still interested',
    subject: 'Engineering Manager',
    body: 'Hello'
  }],
  report: ''
})

const cvPathOnFile = () =>
  (db.prepare('SELECT cv_path FROM contacts WHERE email = ?').get('hr@acme.sa') as { cv_path: string | null }).cv_path

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-cvpath-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
  applyRecord(db, post)
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('an application records the tailored CV it carried', () => {
  persist(db, request('apply'), drafted('apply'), 'draft-1', TAILORED)
  assert.equal(cvPathOnFile(), TAILORED)
})

test('a follow-up never overwrites the CV its application carried', () => {
  persist(db, request('follow-up'), drafted('follow-up'), 'draft-2', null)
  assert.equal(cvPathOnFile(), TAILORED)
})

test('a re-drafted application that fell back records null, not the stale tailored path', () => {
  persist(db, request('apply'), drafted('apply'), 'draft-3', null)
  assert.equal(cvPathOnFile(), null)
})
