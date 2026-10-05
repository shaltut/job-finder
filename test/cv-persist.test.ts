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

// The other machine may be a Mac, where `\` is part of a file name: a tailored path written on Windows
// with `\` fails existsSync there, and the follow-up silently attaches the uploaded CV instead.
test('tailored CV paths are stored with / and old backslash rows still resolve', async () => {
  const { tailoredCvPath } = await import('../server/utils/cv-render.ts')
  const { followUpAttachment } = await import('../server/utils/cv-attach.ts')
  const BS = String.fromCharCode(92) // a backslash, spelled so no editor or shell can unescape it
  assert.equal(tailoredCvPath('data/cv/CV.pdf', 'a.b@x.com').includes(BS), false)
  const seen: string[] = []
  const got = followUpAttachment(['data', 'cv', 'tailored', 'x', 'CV.pdf'].join(BS), 'data/cv/CV.pdf', (p) => {
    seen.push(p)
    return true
  })
  assert.equal(got, 'data/cv/tailored/x/CV.pdf')
  assert.deepEqual(seen, ['data/cv/tailored/x/CV.pdf'])
})

// The sender lane may only send drafts this app made: persist() is where both draft paths record them.
test('persist records a Gmail draft as the app\'s own, never a local file draft', () => {
  persist(db, request('apply'), drafted('apply'), 'r-app-1', null)
  persist(db, request('follow-up'), drafted('follow-up'), 'r-fu-1', null)
  persist(db, request('apply'), drafted('apply'), join('data', 'drafts', 'x.json'), null)
  const rows = db.prepare(`SELECT draft_id, email, mode FROM app_drafts WHERE draft_id IN ('r-app-1', 'r-fu-1') OR draft_id LIKE '%.json' ORDER BY draft_id`).all()
  assert.deepEqual(rows, [
    { draft_id: 'r-app-1', email: 'hr@acme.sa', mode: 'apply' },
    { draft_id: 'r-fu-1', email: 'hr@acme.sa', mode: 'follow-up' }
  ])
})
