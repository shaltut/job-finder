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
  achievements: string[]
  personalDetails: string[]
  interests: string[]
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
  achievements: string[]
  personalDetails: string[]
  interests: string[]
  languages: string[]
}

/**
 * Extraction reads a PDF's text layer, which carries control and format characters the eye never sees —
 * a stray \x0E, a backspace run, a zero-width space. They survive every existing guard (matchKey strips
 * them before comparing, missingBullets only covers bullet text) and would print into a CV a recruiter
 * opens. Stripped here, at the one point where raw extraction becomes the master, so the prompt, the
 * checks and the render all see the same text. Tab, newline and carriage return are kept.
 *
 * Exported because the model's own tailored strings need the same treatment (cv-tailor.ts): they are the
 * only other text that reaches the rendered PDF, and nothing else strips them.
 */
export const clean = (s: string): string =>
  // eslint-disable-next-line no-control-regex -- the point of this regex is to match control characters
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\uFEFF]/g, '')

export function assignIds(cv: CvContent): MasterCv {
  return {
    summary: clean(cv.summary),
    roles: cv.roles.map((r, i) => ({
      id: `r${i}`,
      title: clean(r.title),
      employer: clean(r.employer),
      location: clean(r.location),
      start: clean(r.start),
      end: clean(r.end),
      bullets: r.bullets.map((text, j) => ({ id: `r${i}.b${j}`, text: clean(text) }))
    })),
    skills: cv.skills.map((s, i) => ({ id: `s${i}`, group: clean(s.group), items: s.items.map(clean) })),
    education: cv.education.map(clean),
    certifications: cv.certifications.map(clean),
    achievements: cv.achievements.map(clean),
    personalDetails: cv.personalDetails.map(clean),
    interests: cv.interests.map(clean),
    languages: cv.languages.map(clean)
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
    achievements: [...master.achievements],
    personalDetails: [...master.personalDetails],
    interests: [...master.interests],
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

/**
 * Bump whenever MasterCv's shape changes. The cache was keyed on the PDF's bytes alone, and the PDF does
 * not change when the schema does: `achievements`, `personalDetails` and `interests` were all added to
 * MasterCv after caches existed, and a cache written before them is served forever afterwards.
 * masterCvBlock never reads those fields, so the prompt looks fine; masterText spreads them, so
 * tailoredCv throws "m.achievements is not iterable" — caught, so every email still goes out on the
 * uploaded PDF, but tailoring is off for good until someone deletes the file by hand. It cost a debugging
 * session once already. A cache with no version, or the wrong one, is a miss: re-extraction is two model
 * calls, once.
 */
export const MASTER_CACHE_VERSION = 1

export interface CachedMaster { version: number, pdfSha256: string, extractedAt: string, model: string, cv: MasterCv }

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
  required: ['summary', 'roles', 'skills', 'education', 'certifications', 'achievements', 'personalDetails', 'interests', 'languages'],
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
    achievements: list,
    personalDetails: list,
    interests: list,
    languages: list
  }
} as const

const EXTRACT_INSTRUCTIONS = [
  'Extract this CV into the schema, copying text exactly as it is written.',
  'Copy every bullet verbatim: never reword, merge, split, summarise or correct one.',
  'Keep roles in the order the CV lists them. Use an empty string or an empty list for anything absent.',
  'Each field holds only its own value: employer is the organisation name alone, location is the place alone,',
  'and start and end are the dates alone. Never repeat a date inside employer or location, and never leave a',
  'separator such as a dash stranded in a field.',
  'Put a section of standalone achievements — often titled "Selected Achievements" or similar — in',
  'achievements, one entry per item, verbatim. Leave it empty when the CV has no such section.',
  'Put a personal-details section — date of birth, nationality, marital status and the like — in',
  'personalDetails, one entry per item, verbatim, but leave languages out of it: they have their own field.',
  'Put an interests or hobbies section in interests, one entry per item. Leave either empty when the CV has',
  'no such section.',
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
  if (cached?.pdfSha256 === hash && cached.version === MASTER_CACHE_VERSION) return cached.cv

  const [extracted, text] = await Promise.all([extractor.extract(pdfPath), extractor.verbatim(pdfPath)])
  const master = assignIds(extracted)
  if (!master.roles.length) throw new Error('the CV extraction returned no roles')
  const missing = missingBullets(master, text)
  if (missing.length) {
    throw new Error(`the CV extraction produced bullets the PDF text does not contain: ${missing.join(', ')} — nothing cached`)
  }

  mkdirSync(dirname(cachePath), { recursive: true })
  const record: CachedMaster = {
    version: MASTER_CACHE_VERSION,
    pdfSha256: hash,
    extractedAt: new Date().toISOString(),
    model: extractor.model,
    cv: master
  }
  writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`)
  return master
}

export const MASTER_CV_HEADING = '# Master CV — tailor from this, and only this'

/** One line per value, so a value the extraction returned with line breaks can never split an id from its text. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * The master CV as the drafter sees it, every line carrying the id a tailored bullet must return.
 * Ids go in parentheses: PLACEHOLDER rejects square brackets, so a copied "[r0.b3]" would cost the email.
 * Plain lines and never a markdown rule, because PROMPT_SEPARATOR is itself one.
 */
export function masterCvBlock(master: MasterCv): string {
  return [
    MASTER_CV_HEADING,
    '',
    `Summary: ${oneLine(master.summary)}`,
    '',
    ...master.roles.flatMap(r => [
      `(${r.id}) ${oneLine(r.title)} — ${oneLine(r.employer)}, ${oneLine(r.location)} (${oneLine(r.start)} – ${oneLine(r.end)})`,
      ...r.bullets.map(b => `  (${b.id}) ${oneLine(b.text)}`)
    ]),
    '',
    ...master.skills.map(s => `(${s.id}) ${oneLine(s.group)}: ${s.items.map(oneLine).join(' | ')}`)
  ].join('\n')
}
