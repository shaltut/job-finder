// scraper/ingest.ts — reads the scraper's NDJSON on stdin and writes it to SQLite.
//
//   node scraper/run.ts | node scraper/ingest.ts
//
// The Nitro server does the same thing in-process (server/utils/ingest.ts) when it spawns a scrape from
// the UI, so the write logic lives in one place and both paths behave identically.
import { createInterface } from 'node:readline'
import { applyRecord, openWritableDb, type ScraperRecord } from '../server/utils/ingest.ts'

const { db, close } = openWritableDb()
let posts = 0
let updates = 0

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  let rec: ScraperRecord
  try {
    rec = JSON.parse(line)
  } catch {
    process.stderr.write(`ingest: skipping unparseable line: ${line.slice(0, 120)}\n`)
    continue
  }
  const applied = applyRecord(db, rec)
  if (applied === 'post') posts++
  else if (applied === 'update') updates++
}

close()
process.stderr.write(`ingest: ${posts} new posts, ${updates} rows updated\n`)
