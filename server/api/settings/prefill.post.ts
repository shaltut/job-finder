import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import OpenAI from 'openai'
import { mergeEmpty, settingsSchema } from '../../../shared/settings'
import { cvPath, readConfigLoose } from '../../utils/config'
import { cvExists } from '../../utils/cv'

const MODEL = process.env.JOBFINDER_MODEL || 'gpt-5-nano'

/**
 * What a CV can honestly supply. Everything else in Settings is deliberately absent: a CV cannot
 * know which countries you would relocate to, what hours you will work, or whether you can start
 * immediately, and a model asked for them will invent an answer that then goes out in an email.
 *
 * Strict mode requires additionalProperties:false and every property listed in required, so the
 * model always returns the whole shape and uses '' for anything the document does not state.
 */
const PREFILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'titles', 'terms'],
  properties: {
    profile: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'title', 'location', 'email', 'phone', 'linkedin', 'github', 'languages', 'yearsExperience'],
      properties: {
        name: { type: 'string' },
        title: { type: 'string' },
        location: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        linkedin: { type: 'string' },
        github: { type: 'string' },
        languages: { type: 'string' },
        yearsExperience: { type: 'string' }
      }
    },
    titles: { type: 'array', items: { type: 'string' } },
    terms: { type: 'array', items: { type: 'string' } }
  }
} as const

const INSTRUCTIONS = `You are filling in a job-search tool's settings from one person's CV.

Return only what the document actually states. Use an empty string for anything it does not — never
guess, never infer a plausible value, and never carry over an example. A wrong phone number or email
here goes out on real job applications.

name, title, location, email, phone: exactly as written in the CV. Keep the phone's formatting.
linkedin, github: full https:// URLs. Empty string if the CV shows no such profile.
languages: a short phrase, e.g. "Arabic native, English professional".
yearsExperience: a short string such as "10+" or "6", derived from the employment dates.
titles: 15-30 job titles this person should be searched against, based on the seniority, stack and
domain the CV demonstrates. Real job titles as they appear on postings.
terms: 6-10 LinkedIn search phrases that would surface posts hiring for those titles. Lower case,
2-4 words each, e.g. "senior frontend engineer", "hiring vue developer".`

/**
 * Reads the stored CV and proposes values for the fields that are still blank.
 *
 * The first OpenAI client on the server side — the pattern is lifted from scraper/run.ts: the PDF is
 * inlined as a base64 data URL rather than uploaded through the Files API, and the Responses API
 * nests the schema under text.format, which is not where Chat Completions puts it.
 *
 * Returns the merged config WITHOUT saving. You see what it proposes and press Save yourself.
 */
export default defineEventHandler(async (event) => {
  const config = readConfigLoose()
  if (!config.cv) throw createError({ statusCode: 400, message: 'upload a CV first' })
  if (!cvExists(config.cv)) throw createError({ statusCode: 400, message: `CV not found at ${config.cv}` })
  if (!process.env.OPENAI_API_KEY) {
    throw createError({ statusCode: 400, message: 'OPENAI_API_KEY is not set — add it to .env and restart' })
  }

  const path = cvPath(config)
  let proposal: { profile?: Record<string, string>, titles?: string[], terms?: string[] }
  try {
    const r = await new OpenAI().responses.create({
      model: MODEL,
      reasoning: { effort: 'low' },
      input: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: basename(path), file_data: `data:application/pdf;base64,${readFileSync(path).toString('base64')}` },
          { type: 'input_text', text: INSTRUCTIONS }
        ]
      }],
      text: { format: { type: 'json_schema', name: 'settings_prefill', strict: true, schema: PREFILL_SCHEMA } }
    } as never) as { output_text: string }
    proposal = JSON.parse(r.output_text)
  } catch (e) {
    throw createError({ statusCode: 502, message: `could not read the CV: ${(e as Error).message}` })
  }

  // Merge into what is ON SCREEN, not what is stored. The page posts its unsaved form, so clearing a
  // field and pressing Prefill re-reads it from the CV — which is exactly what the button promises.
  // Falling back to the stored row keeps a malformed body from failing the whole request. `cv` is
  // server-owned either way: the browser does not get to name the file we read.
  const posted = settingsSchema.safeParse(await readBody(event).catch(() => null))
  const base = { ...(posted.success ? posted.data : config), cv: config.cv }

  // empty fields only: anything already set is what the user chose, and the model does not overrule it
  const merged = mergeEmpty(base, proposal)
  const filled = Object.keys(merged.profile).filter(
    k => merged.profile[k as keyof typeof merged.profile] !== base.profile[k as keyof typeof base.profile]
  )
  if (merged.titles.length !== base.titles.length) filled.push('titles')
  if (merged.terms.length !== base.terms.length) filled.push('terms')

  console.log(`[settings] prefill filled ${filled.length ? filled.join(', ') : 'nothing — every field was already set'}`)
  return { config: merged, filled }
})
