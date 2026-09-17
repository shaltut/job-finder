// The check a tailored CV must pass before it is rendered. The first failure rejects the whole CV and
// the uploaded PDF is attached instead (cv-attach.ts).
//
// In code rather than in the procedure for the reason PLACEHOLDER and gateOnPostType() are: the model
// follows a written instruction most of the time, and a stretched claim on a CV sent under the owner's
// name is exactly what "most of the time" cannot cover.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md, section 3.
import { z } from 'zod'
import type { CvContent, MasterCv } from './cv-master.ts'
import { PLACEHOLDER } from './drafter.ts'

// Every id must have the shape code assigns. The structure rules compare ids as joined strings, so an id
// that carried the separator — a model merging two bullets as "r0.b0,r0.b1" — could pass them and then
// throw on the lookup that follows. Constraining the shape makes that a malformed block instead.
const cvBlock = z.object({
  summary: z.string().min(1),
  roles: z.array(z.object({
    id: z.string().regex(/^r\d+$/),
    bullets: z.array(z.object({ id: z.string().regex(/^r\d+\.b\d+$/), text: z.string().min(1) }))
  })),
  skills: z.array(z.object({ id: z.string().regex(/^s\d+$/), items: z.array(z.string()) }))
})

export type TailorResult = { ok: true, cv: CvContent } | { ok: false, reason: string }

const fail = (reason: string): TailorResult => ({ ok: false, reason })

/** Digit runs as the claim they carry: "40%" and "40" are one number, "60%" is another. */
const numbersIn = (text: string): string[] => text.match(/\d+(?:[.,]\d+)?/g) ?? []

/** Words, with trailing sentence punctuation dropped so "PostgreSQL." is "PostgreSQL". */
const tokens = (text: string): string[] =>
  text.split(/[\s,;:()/]+/).map(t => t.replace(/[.!?]+$/, '')).filter(Boolean)

/**
 * Looks like a technology name: letters with a digit, ".", "#" or "+" ("C#", ".NET", "Node.js", "ES6"),
 * or two or more capitals ("AWS"). Pure numbers are rule 4's business, not this one's.
 * ponytail: a shape heuristic — an invented technology in lower or mixed case ("Kubernetes") passes.
 * The spec records a tighter candidate, to be measured against real post text before adopting it.
 */
const isTech = (t: string): boolean => (/[a-z]/i.test(t) && /[\d.#+]/.test(t)) || /^[A-Z]{2,}$/.test(t)

const masterText = (m: MasterCv): string => [
  m.summary,
  ...m.roles.flatMap(r => [r.title, r.employer, r.location, r.start, r.end, ...r.bullets.map(b => b.text)]),
  ...m.skills.flatMap(s => [s.group, ...s.items]),
  ...m.education,
  ...m.certifications,
  ...m.achievements,
  ...m.personalDetails,
  ...m.interests,
  ...m.languages
].join('\n')

/** Rules 4, 5, 6 (when a limit is given) and 7, in that order, for one piece of text. */
function contentProblem(where: string, text: string, sourceNumbers: string[], vocab: Set<string>, maxLength?: number): string | null {
  const known = new Set(sourceNumbers)
  const newNumber = numbersIn(text).find(n => !known.has(n))
  if (newNumber) return `rule 4 at ${where}: "${newNumber}" not in source`
  const newTech = tokens(text).filter(isTech).find(t => !vocab.has(t.toLowerCase()))
  if (newTech) return `rule 5 at ${where}: "${newTech}" is not in the master CV`
  if (maxLength !== undefined && text.length > maxLength) {
    return `rule 6 at ${where}: ${text.length} characters where the limit is ${maxLength}`
  }
  const hole = text.match(PLACEHOLDER)
  if (hole) return `rule 7 at ${where}: unfilled placeholder ${hole[0]}`
  return null
}

export function tailoredCv(raw: unknown, master: MasterCv): TailorResult {
  const parsed = cvBlock.safeParse(raw)
  if (!parsed.success) return fail(`malformed cv block: ${parsed.error.issues[0]?.message ?? 'unreadable'}`)
  const t = parsed.data
  const inOrder = (xs: { id: string }[]) => xs.map(x => x.id).join(',')
  const asSet = (xs: { id: string }[]) => xs.map(x => x.id).sort().join(',')

  // rule 1 — the same roles, in the master's date order
  if (inOrder(t.roles) !== inOrder(master.roles)) {
    return fail(`rule 1: roles ${inOrder(t.roles)} do not match ${inOrder(master.roles)} in date order`)
  }

  // rule 2 — each role's own bullets, each exactly once: none added, dropped or moved between roles
  for (const [i, role] of master.roles.entries()) {
    if (asSet(t.roles[i]!.bullets) !== asSet(role.bullets)) {
      return fail(`rule 2 at ${role.id}: bullets ${asSet(t.roles[i]!.bullets)} do not match ${asSet(role.bullets)}`)
    }
  }

  // rule 3 — the same skill groups in any order, each group's items reordered only
  if (asSet(t.skills) !== asSet(master.skills)) {
    return fail(`rule 3: skill groups ${asSet(t.skills)} do not match ${asSet(master.skills)}`)
  }
  for (const group of t.skills) {
    const source = master.skills.find(s => s.id === group.id)!
    if ([...group.items].sort().join('\n') !== [...source.items].sort().join('\n')) {
      return fail(`rule 3 at ${group.id}: items were renamed, added or removed`)
    }
  }

  // rules 4-7 — each bullet against its own source bullet
  const vocab = new Set(tokens(masterText(master)).map(x => x.toLowerCase()))
  for (const [i, role] of master.roles.entries()) {
    for (const bullet of t.roles[i]!.bullets) {
      const source = role.bullets.find(b => b.id === bullet.id)!
      const limit = Math.floor(source.text.length * 1.5) + 20
      const problem = contentProblem(bullet.id, bullet.text, numbersIn(source.text), vocab, limit)
      if (problem) return fail(problem)
    }
  }

  // rules 4-7 — the summary. Rule 5's vocabulary is the whole master CV, because a technology named
  // anywhere in it is one the owner can claim. Rule 4's numbers are NOT: the whole-CV pool included a
  // date of birth, a graduation year and an employment year, so any of those digits could be re-used as
  // a years-of-experience claim. A number the summary may assert is one the summary or the role dates
  // already carry. Rule 6 applies here for the same reason it applies to a bullet — an unbounded summary
  // is room to argue, and the summary is the first thing a recruiter reads.
  const summaryNumbers = numbersIn([master.summary, ...master.roles.flatMap(r => [r.start, r.end])].join('\n'))
  const summaryProblem = contentProblem('summary', t.summary, summaryNumbers, vocab, Math.floor(master.summary.length * 1.5) + 20)
  if (summaryProblem) return fail(summaryProblem)

  return {
    ok: true,
    cv: {
      summary: t.summary,
      roles: master.roles.map((role, i) => ({
        title: role.title,
        employer: role.employer,
        location: role.location,
        start: role.start,
        end: role.end,
        bullets: t.roles[i]!.bullets.map(b => b.text)
      })),
      skills: t.skills.map(g => ({ group: master.skills.find(s => s.id === g.id)!.group, items: [...g.items] })),
      education: [...master.education],
      certifications: [...master.certifications],
      achievements: [...master.achievements],
      personalDetails: [...master.personalDetails],
      interests: [...master.interests],
      languages: [...master.languages]
    }
  }
}
