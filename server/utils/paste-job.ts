// The impure half of the paste intake: the CV system prompt, the scoring call and the insert.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { systemPrompt, type Config } from '../../scraper/lib.ts'
import { loadCv, scorePost } from '../../scraper/score.ts'
import { readConfig } from './config'
import { applyRecord, openWritableDb } from './ingest'
import { pasteGate, pasteRecord } from './paste'

// The CV text costs one OpenAI call to obtain and never changes while the file does not, so without a
// cache every paste pays for it. On globalThis for the reason __jobfinderRunner is: Nitro's dev HMR
// reloads this module on every edit and module scope would be discarded constantly.
interface CvCache { path: string, mtimeMs: number, system: string }
const g = globalThis as typeof globalThis & { __jobfinderCvSystem?: CvCache }

async function cvSystem(config: Config, push: (line: string) => void): Promise<string> {
  const path = resolve(process.cwd(), config.cv)
  const { mtimeMs } = statSync(path)
  if (g.__jobfinderCvSystem?.path === path && g.__jobfinderCvSystem.mtimeMs === mtimeMs) {
    return g.__jobfinderCvSystem.system
  }
  const system = systemPrompt(await loadCv(config.cv, push), config)
  g.__jobfinderCvSystem = { path, mtimeMs, system }
  return system
}

export async function runPasteJob(text: string, push: (line: string) => void): Promise<number> {
  const config = readConfig()
  const gate = pasteGate(text, config)
  if (!gate.ok) {
    // The endpoint refuses these synchronously; reaching here means the settings changed while queued.
    push(`refused: no enabled contact route (found ${gate.channels.join(', ') || 'none'})`)
    return 1
  }
  const system = await cvSystem(config, push)
  const score = await scorePost(text, system)
  const rec = pasteRecord(text, config, gate, score)
  const { db, close } = openWritableDb()
  try {
    const applied = applyRecord(db, { op: 'post', ...rec })
    push(applied
      ? `stored: ${rec.title || 'untitled'} — score ${rec.score}, ${rec.postType}${rec.flags.length ? `, flags: ${rec.flags.join(' ')}` : ''}`
      : 'already stored: this post is already in the database')
  } finally {
    close()
  }
  return 0
}
