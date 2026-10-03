// The one-time merge of a second machine's separate history. Insert-only: the target's rows always win,
// and settings are never merged.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { mergeInto } from '../scripts/merge-db.ts'

const DDL = `
  CREATE TABLE posts (key TEXT PRIMARY KEY, text TEXT);
  CREATE TABLE applications (key TEXT PRIMARY KEY, verdict TEXT);
  CREATE TABLE contacts (email TEXT PRIMARY KEY, stage TEXT);
  CREATE TABLE post_requirements (key TEXT, term TEXT, status TEXT, PRIMARY KEY (key, term));
  CREATE TABLE requirement_runs (key TEXT PRIMARY KEY, cv_sha TEXT);
  CREATE TABLE settings (id INTEGER PRIMARY KEY, json TEXT);`

test('merge inserts what the target lacks and never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-merge-'))
  const src = new Database(join(dir, 'mac.db'))
  src.exec(DDL)
  src.exec(`INSERT INTO posts VALUES ('k1','mac'),('k2','mac');
            INSERT INTO applications VALUES ('k1','skipped');
            INSERT INTO contacts VALUES ('r@x.com','contacted');
            INSERT INTO post_requirements VALUES ('k1','Redis','absent'),('k2','Redis','present');
            INSERT INTO settings VALUES (1,'{"mac":true}')`)
  src.close()
  const tgt = new Database(join(dir, 'pc.db'))
  tgt.exec(DDL)
  tgt.exec(`INSERT INTO posts VALUES ('k1','pc');
            INSERT INTO applications VALUES ('k1','drafted');
            INSERT INTO post_requirements VALUES ('k1','Redis','present');
            INSERT INTO settings VALUES (1,'{"pc":true}')`)

  const n = mergeInto(tgt, join(dir, 'mac.db'))
  assert.equal(n.posts, 1)
  assert.equal((tgt.prepare(`SELECT text FROM posts WHERE key='k1'`).get() as { text: string }).text, 'pc')
  assert.equal((tgt.prepare(`SELECT verdict FROM applications WHERE key='k1'`).get() as { verdict: string }).verdict, 'drafted')
  assert.equal(n.contacts, 1)
  assert.equal(n.post_requirements, 1, 'only the (k2, Redis) row is new')
  assert.equal((tgt.prepare(`SELECT status FROM post_requirements WHERE key='k1'`).get() as { status: string }).status, 'present')
  assert.equal((tgt.prepare('SELECT json FROM settings').get() as { json: string }).json, '{"pc":true}')
})

test('a source one migration behind merges its shared columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-merge-'))
  const src = new Database(join(dir, 'old.db'))
  src.exec(DDL.replace('key TEXT PRIMARY KEY, text TEXT', 'key TEXT PRIMARY KEY'))
  src.exec(`INSERT INTO posts VALUES ('k9')`)
  src.close()
  const tgt = new Database(join(dir, 'pc.db'))
  tgt.exec(DDL)
  assert.equal(mergeInto(tgt, join(dir, 'old.db')).posts, 1)
})
