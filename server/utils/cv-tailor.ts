// The check a tailored CV must pass before it is rendered. The first failure rejects the whole CV and
// the uploaded PDF is attached instead (cv-attach.ts).
//
// In code rather than in the procedure for the reason PLACEHOLDER and gateOnPostType() are: the model
// follows a written instruction most of the time, and a stretched claim on a CV sent under the owner's
// name is exactly what "most of the time" cannot cover.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md, section 3.
import { z } from 'zod'
import { clean, type CvContent, type MasterCv } from './cv-master.ts'
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
  skills: z.array(z.object({ id: z.string().regex(/^s\d+$/), items: z.array(z.string()) })),
  // nullish: the procedure says omit it, and a model that writes null means the same thing — a type
  // error here would reject the whole cv block and lose every tailored line over the one that was empty
  headline: z.string().nullish()
})

/**
 * `headline`: what prints under the name, in place of the plain profile title — or null, which prints the
 * title. `headlineNote` says why a returned headline was dropped; the rest of the CV stands either way.
 */
export type TailorResult = { ok: true, cv: CvContent, headline: string | null, headlineNote?: string } | { ok: false, reason: string }

/** Joiners a headline may use between its words without the master CV having to contain them. */
const JOINERS = new Set(['·', '|', '-', '–', '—', '&', 'and', 'with', 'in', 'of', 'for'])

/**
 * A word that makes a headline read as a job title. Every word must come from the master CV, but the CV
 * holds "Backend" in a skills group and "Architect" in a certification, and together they make
 * "Backend Architect" — a title the owner never held. The headline describes; the title is theirs.
 */
const ROLE_NOUN = /^(?:architects?|engineers?|developers?|managers?|leads?|directors?|heads?|officers?|cto|cio|vps?|presidents?|consultants?|specialists?|analysts?|administrators?|principals?|founders?)$/i

/**
 * The line under the name, positioned for these posts — within limits that keep it the owner's own:
 * it starts with their title exactly as stored (it may describe them, never rename them), every word
 * after that is a word the master CV already contains, and it carries no number, hedge or placeholder.
 * "<title> · Hands-on <skill> & <skill>" passes; another title in its place does not, nor does a word the
 * master CV never uses, a second job title built from CV words, or a separator with nothing after it.
 *
 * A bad headline is dropped on its own rather than failing the CV: it is one line, and costing the whole
 * tailored CV over it would trade a better fit for a slightly better title line.
 */
function checkHeadline(raw: string | null | undefined, title: string, vocab: Set<string>, allowedHedges: Set<string>): { headline: string | null, note?: string } {
  const h = raw ? oneSpaced(clean(raw)).trim() : ''
  if (!h || h === title) return { headline: null }
  const drop = (why: string) => ({ headline: null, note: `headline dropped (${why}): "${h}"` })
  if (!title) return drop('no profile title to anchor it')
  if (!h.startsWith(title)) return drop('it must start with the profile title')
  if (h.length > title.length + 60) return drop('too long')
  if (/\d/.test(h.slice(title.length))) return drop('a number')
  const words = tokens(h.slice(title.length)).filter(w => !JOINERS.has(w.toLowerCase()))
  if (!words.length) return drop('nothing after the title')
  const alien = words.find(w => !vocab.has(w.toLowerCase()))
  if (alien) return drop(`"${alien.toLowerCase()}" is not in the master CV`)
  const titled = words.find(w => ROLE_NOUN.test(w))
  if (titled) return drop(`"${titled}" reads as another job title`)
  const hole = h.match(PLACEHOLDER)?.[0] ?? hedgeProblem('headline', h, allowedHedges)
  if (hole) return drop(hole)
  return { headline: h }
}

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

/** Every text field of the master CV, one per line — the full view the gap record checks quotes against. */
export const masterText = (m: MasterCv): string => [
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

/**
 * Rule 8's vocabulary: a CV that declares what the candidate lacks. The email is where gaps are declared,
 * honestly and once; the CV positions the candidate for the role and never argues against them. Measured
 * 2026-09-26: 0 of 97 tailored CVs carried any of these, so this pins a habit rather than fixing a leak.
 * Deliberately narrow — no bare "learning" or "gap", which live inside "machine learning" and "bridging the
 * gap" — because a false match costs the tailoring: any failed rule attaches the uploaded PDF instead.
 */
const HEDGE = /\b(?:no (?:direct |hands-on |production |commercial |professional |prior )?(?:experience|exposure)|not yet|limited (?:exposure|experience|knowledge)|lack(?:s|ing)?|basic (?:knowledge|understanding|exposure)|familiar(?:ity)? with|currently (?:learning|ramping)|ramping up|(?:willing|eager|keen) to learn|transferable skills?|(?:skills?|knowledge|experience) gaps?|while (?:i|he|she) (?:have|has) not)\b/i

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

/** Any run of whitespace — newline, tab, NBSP, a double space — as one space, so a hedge cannot hide in it. */
const oneSpaced = (t: string): string => t.replace(/\s+/g, ' ')

/** Every hedge phrase in a text, lower-cased. */
const hedgesIn = (t: string): string[] => [...oneSpaced(t).matchAll(new RegExp(HEDGE.source, 'gi'))].map(m => m[0].toLowerCase())

/**
 * Rule 8, for one piece of text: a hedge that is not one of the master CV's own. EVERY match is checked,
 * and the master's are allowed back only as whole phrases: checking the first match let an allowed hedge
 * shield a new one behind it, and a substring test let "Slack" in the master excuse "lack".
 */
function hedgeProblem(where: string, text: string, allowed: Set<string>): string | null {
  const hedge = hedgesIn(text).find(h => !allowed.has(h))
  return hedge ? `rule 8 at ${where}: "${hedge}" declares a gap — the email declares gaps, the CV never does` : null
}

/** `title` is the profile title, the anchor a headline must start with; with none, no headline is used. */
export function tailoredCv(raw: unknown, master: MasterCv, title = ''): TailorResult {
  const parsed = cvBlock.safeParse(raw)
  if (!parsed.success) return fail(`malformed cv block: ${parsed.error.issues[0]?.message ?? 'unreadable'}`)
  const t = parsed.data

  // assignIds cleans the master; these two are the only other strings that reach the rendered PDF, and
  // they are model output, so they were printing whatever control or format characters the model emitted.
  // Cleaned here rather than in the return block, so every rule below sees exactly the text that will
  // print: a control character wedged inside a token would otherwise hide that token from rule 5.
  // Skill items need none — rule 3 requires them identical to the master's already-clean strings.
  t.summary = clean(t.summary)
  for (const role of t.roles) for (const b of role.bullets) b.text = clean(b.text)

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
  const masterHedges = new Set(hedgesIn(masterText(master)))
  for (const [i, role] of master.roles.entries()) {
    for (const bullet of t.roles[i]!.bullets) {
      const source = role.bullets.find(b => b.id === bullet.id)!
      const limit = Math.floor(source.text.length * 1.5) + 20
      const problem = contentProblem(bullet.id, bullet.text, numbersIn(source.text), vocab, limit)
        ?? hedgeProblem(bullet.id, bullet.text, masterHedges)
      if (problem) return fail(problem)
    }
  }

  // rules 4-7 — the summary. Rule 5's vocabulary is the whole master CV, because a technology named
  // anywhere in it is one the owner can claim. Rule 4's numbers are NOT: the whole-CV pool included a
  // date of birth, a graduation year and an employment year, so any of those digits could be re-used as
  // a years-of-experience claim. A number the summary may assert is one the summary or the role dates
  // already carry. Rule 6 applies here for the same reason it applies to a bullet — an unbounded summary
  // is room to argue, and the summary is the first thing a recruiter reads.
  // The limit has a floor because a master with no summary section gives one of 20, which rejects every
  // tailored CV — and that failure is invisible: each rejection falls back to the uploaded PDF, so the
  // feature just silently never fires. An absent summary is measured as if it were 200 characters; a
  // master that has one is unaffected.
  const summaryNumbers = numbersIn([master.summary, ...master.roles.flatMap(r => [r.start, r.end])].join('\n'))
  const summaryLimit = Math.floor((master.summary.length || 200) * 1.5) + 20
  const summaryProblem = contentProblem('summary', t.summary, summaryNumbers, vocab, summaryLimit)
    ?? hedgeProblem('summary', t.summary, masterHedges)
  if (summaryProblem) return fail(summaryProblem)

  const { headline, note: headlineNote } = checkHeadline(t.headline, oneSpaced(clean(title)).trim(), vocab, masterHedges)

  return {
    ok: true,
    headline,
    ...(headlineNote ? { headlineNote } : {}),
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
