import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import OpenAI from 'openai'
import { BACKGROUND_SCHEMA, backgroundInstructions, gapsFrom, type BackgroundProposal } from '../../../shared/background'
import { mergeEmpty, settingsSchema } from '../../../shared/settings'
import { cvPath, readConfigLoose } from '../../utils/config'
import { cvExists } from '../../utils/cv'

/**
 * NOT the scraper's model. Measured on one real CV with this exact prompt:
 *
 *   gpt-5-nano  requirements: 0   gaps: 0    <- satisfied the schema by returning an empty table
 *   gpt-5-mini  requirements: 17  gaps: 3    <- 14 present, 2 partial, 1 absent, none discarded
 *
 * Nano is not weak at extraction — it produced good evidence and caught every unverified percentage
 * on the same run. It cannot hold a seventeen-row judgement table, and it fails at it SILENTLY: an
 * empty `requirements` array is valid against the strict schema, so the endpoint returns 200 with no
 * gaps and the honesty mechanism is simply absent. That is the worst possible failure for this
 * feature, so the default is raised here rather than being left to whoever configures the scraper.
 *
 * Justified because this call runs once per CV, gated behind human review — unlike the scoring model,
 * which runs per post.
 */
const MODEL = process.env.JOBFINDER_BACKGROUND_MODEL || 'gpt-5-mini'

const clamp = (xs: unknown, cap: number): string[] =>
  (Array.isArray(xs) ? xs : []).map(x => String(x).trim().slice(0, cap)).filter(Boolean)

/**
 * Reads the stored CV and proposes the evidence, gaps and strengths the drafter argues from — the
 * content that used to be hand-written into the drafter's skill file, which is why retargeting this
 * tool used to mean editing a prompt in the repository.
 *
 * Same shape as prefill.post.ts: the PDF is inlined as a base64 data URL, the Responses API nests the
 * schema under text.format, the merge lands in the POSTED form, and nothing is saved — you review it
 * and press Save yourself. That review is not a formality: it is the last check before the model's
 * reading of your CV starts going out to recruiters under your name.
 *
 * Two deliberate differences from prefill. It is told the target titles, not just the CV, because a
 * gap only exists relative to something being asked for. And `reasoning: medium`, because this is a
 * judgement per table row rather than extraction — it is a one-shot, review-gated call, not a
 * per-post one, so it is worth paying for once.
 */
export default defineEventHandler(async (event) => {
  const config = readConfigLoose()
  if (!config.cv) throw createError({ statusCode: 400, message: 'upload a CV first' })
  if (!cvExists(config.cv)) throw createError({ statusCode: 400, message: `CV not found at ${config.cv}` })
  if (!process.env.OPENAI_API_KEY) {
    throw createError({ statusCode: 400, message: 'OPENAI_API_KEY is not set — add it to .env and restart' })
  }

  const raw = await readBody(event).catch(() => null) as { replace?: boolean } | null
  const posted = settingsSchema.safeParse(raw)
  const base = { ...(posted.success ? posted.data : config), cv: config.cv }

  // The closed universe IS the titles. Asking a model what a CV lacks, with nothing to lack it
  // against, is the open question this endpoint is built to avoid — so refuse rather than degrade.
  if (!base.titles.length) {
    throw createError({ statusCode: 400, message: 'add target titles first — Prefill from CV proposes them' })
  }

  const path = cvPath(config)
  let proposal: BackgroundProposal
  try {
    const r = await new OpenAI().responses.create({
      model: MODEL,
      reasoning: { effort: 'medium' },
      input: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: basename(path), file_data: `data:application/pdf;base64,${readFileSync(path).toString('base64')}` },
          { type: 'input_text', text: backgroundInstructions(base.titles, base.scope.roleFamily) }
        ]
      }],
      text: { format: { type: 'json_schema', name: 'settings_background', strict: true, schema: BACKGROUND_SCHEMA } }
    } as never) as { output_text: string }
    proposal = JSON.parse(r.output_text)
  } catch (e) {
    throw createError({ statusCode: 502, message: `could not read the CV: ${(e as Error).message}` })
  }

  const { gaps, kept, dropped } = gapsFrom(proposal.requirements, base.titles)
  // An empty table is schema-valid, so say so loudly rather than returning a background with no gaps
  // and letting it look like this candidate has none.
  if (!proposal.requirements?.length) {
    console.warn(`[settings] ${MODEL} returned no requirements at all — gaps cannot be derived.`
      + ' Set JOBFINDER_BACKGROUND_MODEL to a stronger model and try again.')
  }
  // clamped here rather than at Save, so a long generation is truncated instead of 400ing the form
  const background = {
    strengths: clamp(proposal.strengths, 120).slice(0, 20),
    evidence: String(proposal.evidence ?? '').trim().slice(0, 8000),
    gaps,
    neverClaim: clamp(proposal.neverClaim, 200).slice(0, 20)
  }

  // `replace` is what makes this re-runnable. mergeEmpty fills only what is blank, which is right the
  // first time and wrong every time after: press Generate again having updated your CV and a
  // fill-if-empty merge is a silent no-op. The page asks before sending it.
  const merged = raw?.replace
    ? { ...base, background }
    : mergeEmpty(base, { background })

  const filled = (['strengths', 'evidence', 'gaps', 'neverClaim'] as const)
    .filter(k => JSON.stringify(merged.background[k]) !== JSON.stringify(base.background[k]))
  console.log(
    `[settings] background ${raw?.replace ? 'replaced' : 'filled'} ${filled.join(', ') || 'nothing'}`
    + ` — ${kept.length} gap(s) kept, ${dropped.length} discarded`
  )
  return { config: merged, filled, requirements: kept, dropped }
})
