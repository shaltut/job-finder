// The master CV: the uploaded PDF, read once into structured content and cached against its bytes.
//
// Every rule a tailored CV is checked against (cv-tailor.ts) is anchored on the ids assigned here. They
// are assigned by code rather than by the model because they must be deterministic and unique.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md.
import { createHash } from 'node:crypto'

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
