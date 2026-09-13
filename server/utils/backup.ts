import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DB_PATH } from './db'

const DIR = resolve(process.cwd(), 'backups')
const KEEP = 14

/**
 * SQLite is one file, so `pg_dump` becomes a copy. Uses the VACUUM INTO-free path deliberately: a plain copy
 * of a WAL database is safe here because the server is the only writer and is idle when this runs.
 */
export function backup(now = new Date()): { file: string, pruned: string[] } {
  mkdirSync(DIR, { recursive: true })
  // The host's own time zone, not a hardcoded one: a dated backup filename should match the day it
  // was Tuesday for whoever is running this, wherever they are.
  const date = now.toLocaleDateString('sv-SE') // local date, not UTC
  const file = join(DIR, `jobfinder-${date}.db`)
  copyFileSync(DB_PATH, file)

  const old = readdirSync(DIR).filter(f => f.startsWith('jobfinder-') && f.endsWith('.db')).sort().slice(0, -KEEP)
  old.forEach(f => rmSync(join(DIR, f)))
  return { file, pruned: old }
}
