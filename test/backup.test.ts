// The nightly backup must hold what is committed, not only what has been checkpointed. The server keeps
// its connection open in WAL mode, so recent commits live in `-wal` — and a plain copy of the main file,
// which is what backup() used to do, silently leaves them out. Measured 2026-09-25: 12 posts missing
// from that day's backup.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { backup } from '../server/utils/backup.ts'

test('a backup contains rows still sitting in the WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-backup-'))
  const src = join(dir, 'live.db')
  // the server's posture: WAL, one long-lived connection, and here no automatic checkpoint at all
  const live = new Database(src)
  live.pragma('journal_mode = WAL')
  live.pragma('wal_autocheckpoint = 0')
  live.exec('CREATE TABLE posts (key TEXT PRIMARY KEY)')
  live.pragma('wal_checkpoint(TRUNCATE)') // the table reaches the main file, the rows below do not
  const insert = live.prepare('INSERT INTO posts VALUES (?)')
  for (let i = 0; i < 25; i++) insert.run(`k${i}`)
  const count = (file: string) => {
    const d = new Database(file, { readonly: true })
    try {
      return (d.prepare('SELECT count(*) n FROM posts').get() as { n: number }).n
    } finally {
      d.close()
    }
  }
  try {
    // control: the old copy really does lose them, so this test is measuring the right thing
    copyFileSync(src, join(dir, 'copied.db'))
    assert.equal(count(join(dir, 'copied.db')), 0, 'a main-file copy misses every uncheckpointed row')

    const { file } = backup(src, new Date('2026-09-25T12:00:00'), join(dir, 'backups'))
    assert.equal(count(file), 25)

    // the task can run twice in one day; VACUUM INTO refuses an existing target
    insert.run('k25')
    assert.equal(count(backup(src, new Date('2026-09-25T13:00:00'), join(dir, 'backups')).file), 26)
  } finally {
    live.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed backup leaves that day\'s earlier backup intact, and no partial file behind', () => {
  // VACUUM INTO refuses an existing target, so the target used to be deleted first — and a vacuum that
  // then failed cost the day's good backup. Now it writes a .tmp and renames only on success.
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-backup-'))
  const backups = join(dir, 'backups')
  const src = join(dir, 'live.db')
  const live = new Database(src)
  live.exec('CREATE TABLE posts (key TEXT PRIMARY KEY); INSERT INTO posts VALUES (\'a\'), (\'b\')')
  live.close()
  try {
    const { file } = backup(src, new Date('2026-09-25T08:07:00'), backups)

    // the evening run fails: the source is not a database at all
    const broken = join(dir, 'broken.db')
    writeFileSync(broken, 'not a database, and long enough that SQLite reads a header from it')
    assert.throws(() => backup(broken, new Date('2026-09-25T20:00:00'), backups))

    const d = new Database(file, { readonly: true })
    assert.equal((d.prepare('SELECT count(*) n FROM posts').get() as { n: number }).n, 2, 'the morning backup survives')
    d.close()
    assert.deepEqual(readdirSync(backups), ['jobfinder-2026-09-25.db'], 'and no .tmp is left to count as a backup')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
