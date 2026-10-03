// One-time merge of a second machine's separate history into this database — the history each machine
// built before the hand-off (server/utils/handoff.ts) existed. Insert-only: the target's rows always
// win, settings are never merged, and contacts stages are healed afterwards by a Gmail sweep (Gmail is
// the truth; contacts only caches it).
//
// Usage, with the server STOPPED (it is the sole writer):
//   node scripts/merge-db.ts <source.db> [target.db]
// then start the server and run a sweep from the Pipeline view.
import Database from 'better-sqlite3'

// posts first: the others reference posts.key
const TABLES = ['posts', 'applications', 'contacts', 'post_requirements', 'requirement_runs'] as const

export function mergeInto(target: Database.Database, sourceFile: string): Record<string, number> {
  target.prepare('ATTACH DATABASE ? AS src').run(sourceFile)
  try {
    const out: Record<string, number> = {}
    const columns = (t: string, schema: string) =>
      (target.prepare('SELECT name FROM pragma_table_info(?, ?)').all(t, schema) as { name: string }[]).map(c => c.name)
    target.transaction(() => {
      for (const t of TABLES) {
        // only shared columns, so a source one migration behind still merges
        const theirs = new Set(columns(t, 'src'))
        const shared = columns(t, 'main').filter(c => theirs.has(c)).map(c => `"${c}"`).join(', ')
        out[t] = shared ? target.prepare(`INSERT OR IGNORE INTO main."${t}" (${shared}) SELECT ${shared} FROM src."${t}"`).run().changes : 0
      }
    })()
    return out
  } finally {
    target.exec('DETACH DATABASE src')
  }
}

if (process.argv[1]?.endsWith('merge-db.ts')) { // run directly, not imported by the test
  const [source, targetFile = process.env.JOBFINDER_DB || 'data/jobfinder.db'] = process.argv.slice(2)
  if (!source) {
    console.error('usage: node scripts/merge-db.ts <source.db> [target.db]')
    process.exit(1)
  }
  const db = new Database(targetFile)
  console.log(mergeInto(db, source))
  db.close()
}
