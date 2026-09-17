// The master CV: the uploaded PDF, read once into structured content and cached against its bytes.
//
// Every rule a tailored CV is checked against (cv-tailor.ts) is anchored on the ids assigned here. They
// are assigned by code rather than by the model because they must be deterministic and unique.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import OpenAI from 'openai'

export interface CvContent {
  summary: string
  roles: { title: string, employer: string, location: string, start: string, end: string, bullets: string[] }[]
  skills: { group: string, items: string[] }[]
  education: string[]
  certifications: string[]
  languages: string[]
}

export interface MasterBullet { id: string, text: string }
export interface MasterRole {
  id: string
  title: string
  employer: string
  location: string
  start: string
  end: string
  bullets: MasterBullet[]
}
export interface MasterSkillGroup { id: string, group: string, items: string[] }
export interface MasterCv {
  summary: string
  roles: MasterRole[]
  skills: MasterSkillGroup[]
  education: string[]
  certifications: string[]
  languages: string[]
}

export function assignIds(cv: CvContent): MasterCv {
  return {
    summary: cv.summary,
    roles: cv.roles.map((r, i) => ({
      id: `r${i}`,
      title: r.title,
      employer: r.employer,
      location: r.location,
      start: r.start,
      end: r.end,
      bullets: r.bullets.map((text, j) => ({ id: `r${i}.b${j}`, text }))
    })),
    skills: cv.skills.map((s, i) => ({ id: `s${i}`, group: s.group, items: [...s.items] })),
    education: [...cv.education],
    certifications: [...cv.certifications],
    languages: [...cv.languages]
  }
}

export function toContent(master: MasterCv): CvContent {
  return {
    summary: master.summary,
    roles: master.roles.map(r => ({
      title: r.title,
      employer: r.employer,
      location: r.location,
      start: r.start,
      end: r.end,
      bullets: r.bullets.map(b => b.text)
    })),
    skills: master.skills.map(s => ({ group: s.group, items: [...s.items] })),
    education: [...master.education],
    certifications: [...master.certifications],
    languages: [...master.languages]
  }
}

/**
 * The form two texts are compared in. NFKC folds the ligatures a PDF often carries ("ﬁ") into plain
 * letters, and dropping everything but letters and digits means a line wrap, a bullet glyph or a changed
 * dash can never make a real bullet look missing. Unicode-aware, so an Arabic CV compares too.
 */
export const matchKey = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Ids of extracted bullets that do not appear in the verbatim text of the same PDF. Nobody reviews the
 * cache, so this is the defence against the extraction inventing or merging a bullet.
 * ponytail: two independent model calls agreeing, not a proof — the verbatim text is model output too.
 */
export function missingBullets(master: MasterCv, verbatim: string): string[] {
  const haystack = matchKey(verbatim)
  return master.roles
    .flatMap(r => r.bullets)
    .filter(b => !haystack.includes(matchKey(b.text)))
    .map(b => b.id)
}

export const pdfSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const MASTER_CACHE = 'data/cv/master.json'

export interface CachedMaster { pdfSha256: string, extractedAt: string, model: string, cv: MasterCv }

/** The two model calls, injectable so the cache logic is testable without a network. */
export interface Extractor {
  model: string
  extract: (pdfPath: string) => Promise<CvContent>
  verbatim: (pdfPath: string) => Promise<string>
}

const list = { type: 'array', items: { type: 'string' } } as const

const CV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'roles', 'skills', 'education', 'certifications', 'languages'],
  properties: {
    summary: { type: 'string' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'employer', 'location', 'start', 'end', 'bullets'],
        properties: {
          title: { type: 'string' },
          employer: { type: 'string' },
          location: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          bullets: list
        }
      }
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['group', 'items'],
        properties: { group: { type: 'string' }, items: list }
      }
    },
    education: list,
    certifications: list,
    languages: list
  }
} as const

const EXTRACT_INSTRUCTIONS = [
  'Extract this CV into the schema, copying text exactly as it is written.',
  'Copy every bullet verbatim: never reword, merge, split, summarise or correct one.',
  'Keep roles in the order the CV lists them. Use an empty string or an empty list for anything absent.',
  'Leave out the name and the contact details; they are supplied elsewhere.'
].join(' ')

/**
 * gpt-5-mini by default, not nano: nano satisfied a strict schema in background.post.ts by returning an
 * empty table, and an empty extraction here would silently turn tailoring off.
 */
export function openAiExtractor(): Extractor {
  const model = process.env.JOBFINDER_CV_MODEL || 'gpt-5-mini'
  const file = (pdfPath: string) => ({
    type: 'input_file',
    filename: basename(pdfPath),
    file_data: `data:application/pdf;base64,${readFileSync(pdfPath).toString('base64')}`
  })
  return {
    model,
    extract: async (pdfPath) => {
      const r = await new OpenAI().responses.create({
        model,
        reasoning: { effort: 'low' },
        input: [{ role: 'user', content: [file(pdfPath), { type: 'input_text', text: EXTRACT_INSTRUCTIONS }] }],
        text: { format: { type: 'json_schema', name: 'master_cv', strict: true, schema: CV_SCHEMA } }
      } as never) as { output_text: string }
      return JSON.parse(r.output_text) as CvContent
    },
    verbatim: async (pdfPath) => {
      const r = await new OpenAI().responses.create({
        model,
        reasoning: { effort: 'low' },
        input: [{
          role: 'user',
          content: [file(pdfPath), { type: 'input_text', text: 'Return the complete plain text of this document verbatim, with no commentary.' }]
        }]
      } as never) as { output_text: string }
      return r.output_text
    }
  }
}

function readCache(path: string): CachedMaster | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CachedMaster
  } catch {
    return null // absent or unreadable: rebuilt below, never fatal
  }
}

/**
 * The master CV for the PDF at `pdfPath`: from the cache while its hash matches the PDF, extracted and
 * cached otherwise — so uploading a new CV invalidates it with no extra code. Throws, and caches nothing,
 * when the extraction cannot be trusted; the caller attaches the uploaded PDF instead.
 */
export async function loadMasterCv(
  pdfPath: string,
  extractor: Extractor = openAiExtractor(),
  cachePath: string = MASTER_CACHE
): Promise<MasterCv> {
  const hash = pdfSha256(readFileSync(pdfPath))
  const cached = readCache(cachePath)
  if (cached?.pdfSha256 === hash) return cached.cv

  const [extracted, text] = await Promise.all([extractor.extract(pdfPath), extractor.verbatim(pdfPath)])
  const master = assignIds(extracted)
  if (!master.roles.length) throw new Error('the CV extraction returned no roles')
  const missing = missingBullets(master, text)
  if (missing.length) {
    throw new Error(`the CV extraction produced bullets the PDF text does not contain: ${missing.join(', ')} — nothing cached`)
  }

  mkdirSync(dirname(cachePath), { recursive: true })
  const record: CachedMaster = { pdfSha256: hash, extractedAt: new Date().toISOString(), model: extractor.model, cv: master }
  writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`)
  return master
}
