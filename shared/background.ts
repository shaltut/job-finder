// Turning a CV into the "what may this person honestly claim" half of the drafter prompt.
//
// Pure, like shared/settings.ts: no node:fs and no OpenAI import, so the tests exercise the part that
// decides what survives without a network call. The endpoint in server/api/settings/ owns the call.
//
// THE PROBLEM THIS FILE EXISTS TO SOLVE. Evidence is extraction and is safe — you ask what a document
// says. Gaps are ABSENCES, and "what does this CV lack?" is an open question with no closed universe,
// so a model answers it by inventing something plausible. An invented gap is worse than a missed one:
// it makes every future application apologise for a weakness the person does not have.
//
// So gaps are never a field the model writes. The model fills in a verdict TABLE — one row per
// requirement, each attributed to one of the user's own target titles — and `gapsFrom` below projects
// the gaps out of it, discarding any row it cannot justify. To invent a gap the model would have to
// invent a requirement AND attribute it to a title the user actually searches, and the attribution is
// checked in code rather than asked for in prose.

/** One row of the model's verdict table. */
export interface RequirementRow {
  requirement: string
  /** must be one of the user's own target titles, copied exactly — enforced below, not just asked for */
  askedForBy: string
  status: 'present' | 'partial' | 'absent'
  /** the CV words that settle it; '' for 'absent', because there is nothing to quote */
  cvShows: string
  /** one third-person sentence stating what this means for an application */
  sentence: string
}

export interface BackgroundProposal {
  evidence: string
  neverClaim: string[]
  strengths: string[]
  requirements: RequirementRow[]
}

/** Matches the background.gaps cap in settingsSchema, minus headroom for hand-added gaps. */
export const MAX_GAPS = 12

export const BACKGROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['evidence', 'neverClaim', 'strengths', 'requirements'],
  properties: {
    evidence: { type: 'string' },
    neverClaim: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement', 'askedForBy', 'status', 'cvShows', 'sentence'],
        properties: {
          requirement: { type: 'string' },
          askedForBy: { type: 'string' },
          status: { type: 'string', enum: ['present', 'partial', 'absent'] },
          cvShows: { type: 'string' },
          sentence: { type: 'string' }
        }
      }
    }
  }
} as const

/** Why this row may not become a gap, or null when it may. Order matters only for the message. */
function rejection(
  r: RequirementRow, sentence: string, shows: string,
  allow: Set<string>, seen: Set<string>, keptSoFar: number
): string | null {
  // the attribution check is the teeth: a gap must be wanted by a title this person actually searches
  if (!allow.has(String(r?.askedForBy ?? '').trim().toLowerCase())) return 'attributed to a title you do not target'
  if (r.status === 'present') return 'not a gap'
  if (!sentence) return 'no sentence'
  // a quoted first-person sentence is reused verbatim in the email, so it must come from the person
  if (/^["'\u201c\u2018]/.test(sentence)) return 'a quoted first-person sentence must come from you, not the model'
  if (r.status === 'partial' && !shows) return 'a partial gap with nothing quoted from the CV'
  if (r.status === 'absent' && shows) return 'marked absent but quotes the CV'
  if (seen.has(sentence.toLowerCase())) return 'duplicate'
  if (keptSoFar >= MAX_GAPS) return `more than ${MAX_GAPS} gaps`
  return null
}

/**
 * Projects gap bullets out of the verdict table. Every drop is a gap the model wanted and could not
 * justify; `dropped` is returned rather than swallowed so the page can show what was discarded and
 * why, which is also how you notice a prompt that has started to drift.
 */
export function gapsFrom(rows: RequirementRow[], titles: string[]): {
  gaps: string[]
  kept: RequirementRow[]
  dropped: { row: RequirementRow, why: string }[]
} {
  const allow = new Set(titles.map(t => t.trim().toLowerCase()).filter(Boolean))
  const kept: RequirementRow[] = []
  const dropped: { row: RequirementRow, why: string }[] = []
  const seen = new Set<string>()

  for (const r of Array.isArray(rows) ? rows : []) {
    const sentence = String(r?.sentence ?? '').trim()
    const shows = String(r?.cvShows ?? '').trim()
    const why = rejection(r, sentence, shows, allow, seen, kept.length)
    if (why) {
      // 'present' is not a rejection, it is simply not a gap — reporting it would be noise
      if (why !== 'not a gap') dropped.push({ row: r, why })
      continue
    }
    seen.add(sentence.toLowerCase())
    kept.push({ ...r, sentence: sentence.slice(0, 600) })
  }
  return { gaps: kept.map(r => r.sentence), kept, dropped }
}

/**
 * The universe is the user's own target titles. Without them the question reopens and the whole
 * mechanism collapses, which is why the endpoint refuses to run on an empty titles list.
 */
export function backgroundInstructions(titles: string[], roleFamily: string): string {
  return `You are filling in the "what this person can honestly claim" section of a job-search tool,
from their CV. It is not a technology CV by default — it may be from any profession.

Everything you write here goes into real application emails sent in this person's name. A claim the
CV does not support is a lie told on their behalf. A gap the CV does not actually have makes every
future email apologise for a problem that does not exist. Both are worse than returning less.

This person searches for these job titles, and only these:
${titles.map(t => `  - ${t}`).join('\n')}
${roleFamily
  ? `They describe their field as: ${roleFamily}`
  : 'They have not named their field; infer it from the CV and do not widen it.'}

--- evidence ---
One markdown block: the facts an email may draw on, and nothing else.
  * Roles: every employer and title exactly as the CV writes them, with the dates it gives.
  * Named work: projects, cases, publications, deployments, clients, campaigns, postings — whatever
    this CV lists. Include a URL only if the CV prints one. Name the tools, methods, standards,
    systems, materials or specialisms attached to a piece of work only where the CV attaches them to
    THAT piece of work.
  * Scale and responsibility: team sizes, headcount led, budgets, volumes, caseloads, durations,
    throughput — only figures the CV states.
  * Qualifications, licences, certifications, registrations, memberships and education, if present.
Use the CV's own words for anything technical or professional. Do not compress a ten-year role into
an adjective. Do not add an employer, project, figure, tool, place or date that is not in the document.

--- neverClaim ---
Figures or claims the CV itself marks as uncertain: an estimate, an approximation, "circa", "~",
"approx.", "self-assessed", a percentage the document flags as unverified, or a proficiency bar with
no source behind it. Quote each one and say what it is attached to, so the email can use a hard number
instead. Return an empty array if the CV marks nothing this way. Do not list a figure merely because
it is large.

--- strengths ---
Three to ten short noun phrases: capabilities this CV evidences that are comparatively uncommon among
people holding the titles listed above. Every one must be visible in the CV. These are a ranking hint,
not a claim, so keep them phrases, not sentences.

--- requirements ---
This is the important one, and it is a checklist, not an essay.

List eight to twenty requirements that postings for the titles listed above commonly state. Work title
by title. For EACH requirement, decide from the CV alone:
  status "present" - the CV plainly shows it.
  status "partial" - the CV shows some of it, less of it, or an older version of it.
  status "absent"  - the CV does not show it anywhere.

Rules that decide whether an entry survives:
  * askedForBy must be one of the titles listed above, copied exactly. An entry attributed to
    anything else is discarded without being read.
  * cvShows: for "present" and "partial", the words from the CV that settle it. For "absent", the
    empty string - there is nothing to quote. An "absent" entry carrying a quote is a contradiction
    and is discarded.
  * sentence: one sentence, third person, stating what this means for an application. For "present",
    a plain statement of the fact. For "partial" and "absent", state what is missing AND what the CV
    shows instead. Never explain why it is missing, never apologise, never promise to learn it, and
    never speculate about this person's plans or motives.
  * Do not write a sentence in the first person, and do not wrap a sentence you wrote in quotation
    marks. A quoted first-person sentence has a special meaning in this tool and must come from the
    person, not from you. Such an entry is discarded.

Do not list a requirement in order to be able to mark it absent. Ask what the job asks for first, then
look. If you cannot name a title above that asks for it, leave it out entirely.`
}
