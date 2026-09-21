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
