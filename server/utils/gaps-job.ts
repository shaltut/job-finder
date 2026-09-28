// The impure half of the gap record: the OpenAI call, the master CV and the database handle that
// extractGaps (server/utils/gaps.ts) takes as arguments, so the orchestration stays testable there.
import { readFileSync } from 'node:fs'
import OpenAI from 'openai'
import { cvPath, readConfigLoose } from './config'
import { cvExists } from './cv'
import { loadMasterCv, pdfSha256 } from './cv-master'
import { masterText } from './cv-tailor'
import { extractGaps, REQUIREMENTS_SCHEMA, requirementsInstructions, type RawRequirement } from './gaps'
import { openWritableDb } from './ingest'

/**
 * gpt-5-mini by default, not the scorer's nano: on this exact kind of per-requirement table nano returned
 * an empty array — valid against the strict schema, so the failure is silent. Measured in
 * server/api/settings/background.post.ts (nano 0 requirements, mini 17).
 */
const MODEL = process.env.JOBFINDER_GAPS_MODEL || 'gpt-5-mini'

let openai: OpenAI | undefined

/** `signal` is the job's own AbortSignal, so Stop cancels the in-flight call (measured up to 165s)
 * instead of waiting for it. GapsDeps.ask has no signal of its own — runGapsJob closes over it below. */
async function ask(postText: string, cvText: string, signal?: AbortSignal): Promise<RawRequirement[]> {
  openai ??= new OpenAI()
  const r = await openai.responses.create({
    model: MODEL,
    reasoning: { effort: 'medium' },
    input: [
      { role: 'system', content: requirementsInstructions() },
      { role: 'user', content: `--- JOB POST ---\n${postText}\n\n--- CV ---\n${cvText}` }
    ],
    text: { format: { type: 'json_schema', name: 'post_requirements', strict: true, schema: REQUIREMENTS_SCHEMA } }
  } as never, { signal }) as { output_text: string }
  return (JSON.parse(r.output_text) as { requirements: RawRequirement[] }).requirements
}

/** The `gaps` job. `keys` limits it to those posts (after a draft); none means every pending application
 * (Extract gaps). Exit 0 when every pending application was read, 1 otherwise. */
export async function runGapsJob(
  job: { added: number }, keys: string[] | undefined, push: (line: string) => void, signal: AbortSignal
): Promise<number> {
  // loose, not readConfig(): reading gaps needs the CV and nothing a scrape needs
  const config = readConfigLoose()
  if (!config.cv || !cvExists(config.cv)) {
    push('gaps: no CV uploaded — upload one in Settings first')
    return 1
  }
  if (!process.env.OPENAI_API_KEY) {
    push('gaps: OPENAI_API_KEY is not set — add it to .env and restart')
    return 1
  }
  const path = cvPath(config)
  // a cache hit costs nothing; a new CV costs the two extraction calls once, as tailoring already does
  const master = await loadMasterCv(path)
  const { db, close } = openWritableDb()
  try {
    const { stored, pending } = await extractGaps(db, {
      ask: (t, cv) => ask(t, cv, signal),
      cvText: masterText(master),
      cvSha: pdfSha256(readFileSync(path)),
      model: MODEL
    }, push, signal, keys)
    job.added = stored
    return stored === pending ? 0 : 1
  } finally {
    close()
  }
}
