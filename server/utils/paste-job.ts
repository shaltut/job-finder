// The impure half of the paste intake: the CV system prompt and the real effects that pasteOnce
// (server/utils/paste.ts) takes as arguments — the orchestration itself lives there now, so it can
// be tested with injected dependencies instead of assertions over this file's source text.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { systemPrompt, type Config } from '../../scraper/lib.ts'
import { loadCv, scorePost } from '../../scraper/score.ts'
import { readConfig } from './config'
import { applyRecord, openWritableDb } from './ingest'
import { pasteOnce } from './paste'

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
  return pasteOnce(text, config, {
    system: () => cvSystem(config, push),
    score: scorePost,
    store: (rec) => {
      const { db, close } = openWritableDb()
      try {
        return !!applyRecord(db, { op: 'post', ...rec })
      } finally {
        close()
      }
    }
  }, push)
}
