import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const DIR = resolve(process.cwd(), 'backups')
const KEEP = 14

/**
 * A dated snapshot through `VACUUM INTO`, never a file copy.
 *
 * The database runs in WAL mode and the server holds its connection open, so committed transactions
 * sit in `-wal` until a checkpoint moves them into the main file — "the server is idle" does not mean
 * they have. The old `copyFileSync(DB_PATH)` copied the main file alone: measured 2026-09-25, that
 * day's backup lacked 12 posts that had been committed hours before it ran, and a copy taken that
 * evening would have lacked 48 posts, 26 applications and 18 contacts. VACUUM INTO reads through the
 * WAL like any other reader, so the snapshot is the database as it stands. test/backup.test.ts pins it.
 *
 * `src` is a parameter, not an import of DB_PATH: server/utils/db.ts opens the database on import,
 * which is what kept this function untested.
 */
export function backup(src: string, now = new Date(), dir = DIR): { file: string, pruned: string[] } {
  mkdirSync(dir, { recursive: true })
  // The host's own time zone, not a hardcoded one: a dated backup filename should match the day it
  // was Tuesday for whoever is running this, wherever they are.
  const date = now.toLocaleDateString('sv-SE') // local date, not UTC
  const file = join(dir, `jobfinder-${date}.db`)
  // VACUUM INTO refuses an existing target, and the task can run twice in a day (by hand, or a restart).
  // So it writes beside the target and is renamed over it only on success: deleting the target first
  // meant a failed vacuum (disk full, I/O) cost that day's good backup, and could leave a partial file
  // counted among the 14 kept. `.db.tmp` does not end in `.db`, so pruning never sees one.
  const tmp = `${file}.tmp`
  rmSync(tmp, { force: true })
  const db = new Database(src, { readonly: true, fileMustExist: true })
  try {
    db.prepare('VACUUM INTO ?').run(tmp)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  } finally {
    db.close()
  }
  renameSync(tmp, file) // replaces an existing file, on Windows too

  const old = readdirSync(dir).filter(f => f.startsWith('jobfinder-') && f.endsWith('.db')).sort().slice(0, -KEEP)
  old.forEach(f => rmSync(join(dir, f)))
  return { file, pruned: old }
}
