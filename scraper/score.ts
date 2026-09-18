// The scoring calls, shared by the scraper and the server's paste lane. Kept out of scraper/lib.ts,
// which every test imports and which is deliberately free of `openai` and `node:fs`.
import fs from 'node:fs'
import { basename } from 'node:path'
import OpenAI from 'openai'
import { SCORE_SCHEMA, gateOnPostType } from './lib.ts'

const MODEL = process.env.JOBFINDER_MODEL || 'gpt-5-nano'

let openai: OpenAI | undefined

export interface Score {
  post_type: 'hiring' | 'seeking' | 'other'
  title: string
  company: string
  location: string
  is_remote: boolean
  is_in_scope: boolean
  score: number
  reason: string
}

/** The model reads the PDF itself, one call per run; no local PDF parser. */
export async function loadCv(path: string, log?: (s: string) => void): Promise<string> {
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'user', content: [
      { type: 'input_file', filename: basename(path), file_data: `data:application/pdf;base64,${fs.readFileSync(path).toString('base64')}` },
      { type: 'input_text', text: 'Return the complete plain text of this document verbatim, with no commentary.' }
    ] }]
  } as never) as { output_text: string }
  log?.(`cv: ${path} (${r.output_text.length} chars)`)
  return r.output_text
}

export async function scorePost(text: string, system: string): Promise<Score> {
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'system', content: system }, { role: 'user', content: text }],
    text: { format: { type: 'json_schema', name: 'job_post', strict: true, schema: SCORE_SCHEMA } }
  } as never) as { output_text: string }
  return gateOnPostType(JSON.parse(r.output_text) as Score)
}
