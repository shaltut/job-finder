// Runs the job-application-drafter skill headlessly and validates what it returns.
//
// The skill gets NO tools: the server loads the posts, groups them by recruiter, writes the draft and
// records the verdicts. The model only screens and writes prose. That makes the run cheap to reason about
// (nothing it returns can act on its own) and fast — with the MCP servers on this machine skipped, startup
// is ~30s rather than the 3-5 minutes the original paid.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AppConfig } from './config'
import { masterCvBlock, type MasterCv } from './cv-master.ts'

/**
 * Procedure only — how to screen and how to write. Every fact about the candidate is injected above
 * it from the settings row, so this file is identical on every install.
 *
 * It deliberately does NOT live in `.claude/skills/`. The drafter spawns in an empty directory and
 * the CLI never discovered it as a skill anyway; all sitting there achieved was making a server data
 * file appear as an interactive skill, described in terms of one person, in every Claude session
 * opened in this repo.
 */
const PROCEDURE_PATH = resolve(process.cwd(), 'server/prompts/drafter-procedure.md')

export function readProcedure(): string {
  try {
    return readFileSync(PROCEDURE_PATH, 'utf8')
  } catch {
    throw new Error(`drafter procedure not found at ${PROCEDURE_PATH} — the server must run from the repo root`)
  }
}

/**
 * `--allowed-tools` and `--disallowed-tools` are variadic: a flag that follows one with no values of its
 * own is swallowed as a tool name. `--allowed-tools` also refuses an empty list. So the allow list names a
 * tool that does not exist, the deny list is explicit, and neither is ever the last flag before a value.
 * Verified: Bash is refused and --append-system-prompt still lands.
 */
const DENY = ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task', 'TodoWrite']

/**
 * The drafter runs from an empty directory, NOT the project root.
 *
 * `claude -p` loads the CLAUDE.md of its working directory, and this project's still describes the tool in
 * terms of its original owner. That leaked once already: a run referred to the candidate by the previous
 * owner's name in its report. The identity in the appended prompt is the only identity this run should see,
 * and since it has no tools it needs nothing from the project folder — the skill text is read here, before
 * the spawn, and passed in as a system prompt.
 */
function neutralCwd(): string {
  const dir = join(tmpdir(), 'jobfinder-drafter')
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface DraftPost {
  key: string
  title: string | null
  company: string | null
  location: string | null
  score: number | null
  /** The scorer's "who is posting" call. Null on rows scored before the column existed. */
  postType: 'hiring' | 'seeking' | 'other' | null
  flags: string[]
  text: string
}

export interface DraftRequest {
  mode: 'apply' | 'follow-up'
  /**
   * The owner picked these posts by hand in the Posts view, rather than the batch queue picking
   * them. It softens the procedure's fit screen (see drafter-procedure.md), but the promise that
   * a chosen post is never recorded as `skipped` is kept in code — by persist() and by the Gmail
   * gate in jobs.ts — because the model follows a written instruction only most of the time, the
   * same reason gateOnPostType() and PLACEHOLDER are code rather than prompt.
   */
  chosen?: boolean
  recruiterEmail: string
  posts: DraftPost[]
}

const resultSchema = z.object({
  key: z.string().min(1),
  verdict: z.enum(['drafted', 'skipped']),
  reason: z.string().min(1),
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  gaps_declared: z.array(z.string()).optional()
})

const responseSchema = z.object({
  results: z.array(resultSchema).min(1),
  report: z.string().default(''),
  // The tailored CV, deliberately untyped. Zod strips unknown keys, so without this line the block would
  // vanish silently; typed here, a malformed CV would fail the email it arrived with. tailoredCv() in
  // cv-tailor.ts validates it on its own, and any failure attaches the uploaded PDF.
  cv: z.unknown().optional()
})

export type DraftResult = z.infer<typeof resultSchema>
export type DraftResponse = z.infer<typeof responseSchema>

export const PROMPT_SEPARATOR = '\n\n---\n\n'

/** The identity and constraints the skill deliberately does not hardcode. */
export function profileBlock(config: AppConfig): string {
  const p = config.profile
  const c = config.constraints
  return [
    '# Candidate identity and constraints (authoritative — overrides anything remembered elsewhere)',
    '',
    `Name: ${p.name}`,
    `Current title: ${p.title}`,
    `Based in: ${p.location}`,
    `Email: ${p.email}`,
    `Phone: ${p.phone}`,
    `LinkedIn: ${p.linkedin}`,
    p.github ? `GitHub: ${p.github}` : '',
    `Languages: ${p.languages}`,
    `Years of experience: ${p.yearsExperience}`,
    '',
    `Accepts location-free remote roles from anywhere: ${c.remoteAnywhere ? 'yes' : 'no'}`,
    `On-site or hybrid roles are in scope only in: ${c.onsiteCountries.join(', ')}`,
    `Willing to relocate to: ${c.willRelocate.length ? c.willRelocate.join(', ') : 'nowhere'}`,
    `Can start immediately: ${c.canStartImmediately ? 'yes' : 'no — there is a notice period'}`,
    `Acceptable working hours: ${c.workingHours}`,
    // Stated only when a post asks for it. Injected either way, because the model has to be able to
    // tell "the owner did not give me one" apart from "no post asked": the first is a reason to skip
    // a post outright, and the second is not. Neither is a reason to invent a number.
    c.expectedSalary
      ? `Expected salary, to quote verbatim when a post asks for one: ${c.expectedSalary}`
      : 'Expected salary: NOT PROVIDED. If a post requires one, skip that post and say so in `reason`.'
  ].filter(Boolean).join('\n')
}

/** Shown in place of a section the user has not filled in yet. */
const NONE = '(none provided — do not invent one; say so in `reason` if you need it)'

const bullets = (xs: string[]): string => xs.length ? xs.map(x => `- ${x}`).join('\n') : NONE

/**
 * What counts as a match. Every line is omitted when its setting is empty, so a half-filled install
 * gets no rule rather than a rule with a blank in it — an empty "Field of work:" reads to the model
 * as a field named nothing, and it will screen against it.
 */
export function scopeBlock(config: AppConfig): string {
  const s = config.scope
  return [
    '# Field and level',
    '',
    s.roleFamily ? `Field of work: ${s.roleFamily}` : '',
    s.seniorityFloor > 0
      ? `Seniority floor: a posting asking for ${s.seniorityFloor} years or fewer is below this candidate's level`
      : '',
    s.primarySkills.length ? `Primary skills: ${s.primarySkills.join(', ')}` : '',
    s.secondarySkills.length ? `Secondary skills: ${s.secondarySkills.join(', ')}` : '',
    s.excludedRoles.length ? `Out of scope — these are other people's jobs: ${s.excludedRoles.join('; ')}` : ''
  ].filter(Boolean).join('\n')
}

export function evidenceBlock(config: AppConfig): string {
  return `# Evidence — the only facts the candidate may claim\n\n${config.background.evidence || NONE}`
}

export function gapsBlock(config: AppConfig): string {
  const b = config.background
  const never = b.neverClaim.length
    ? `\n\n## Never claim\n\n${bullets(b.neverClaim)}`
    : ''
  return `# Gaps — declare these, never paper over them\n\n${bullets(b.gaps)}${never}`
}

export function strengthsBlock(config: AppConfig): string {
  return `# Strengths to lead with — rank a posting higher when it asks for these\n\n${bullets(config.background.strengths)}`
}

/**
 * Everything about this person. The half of the prompt that changes per install — the procedure file
 * below the separator is byte-identical for everyone, and a test asserts exactly that.
 */
export function candidateBlock(config: AppConfig): string {
  return [
    profileBlock(config), scopeBlock(config), evidenceBlock(config),
    gapsBlock(config), strengthsBlock(config)
  ].join('\n\n')
}

/**
 * The longest system prompt allowed. It travels on the command line (`--append-system-prompt`), Windows
 * caps a whole command line at 32,767 characters, and argument escaping inflates the prompt on the way.
 * Measured 2026-09-17: ~17,400 characters before a master CV, ~6,500 more with one.
 */
export const PROMPT_BUDGET = 28_000

export function buildSystemPrompt(config: AppConfig, master: MasterCv | null = null): string {
  const cv = master ? `\n\n${masterCvBlock(master)}` : ''
  return `${candidateBlock(config)}${cv}${PROMPT_SEPARATOR}${readProcedure()}`
}

/** False when injecting this master CV would push the prompt past PROMPT_BUDGET. */
export const fitsPromptBudget = (config: AppConfig, master: MasterCv): boolean =>
  buildSystemPrompt(config, master).length <= PROMPT_BUDGET

/** Strips a ```json fence if the model adds one despite being told not to. */
export function parseResponse(raw: string): DraftResponse {
  let text = raw.trim()
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fence) text = fence[1]!.trim()
  // tolerate leading/trailing prose by taking the outermost JSON object
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end < start) throw new Error(`drafter returned no JSON object: ${raw.slice(0, 200)}`)
    text = text.slice(start, end + 1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`drafter returned unparseable JSON: ${(e as Error).message}`, { cause: e })
  }
  return responseSchema.parse(parsed)
}

/**
 * An unfilled slot the model left for a human to complete — or a master-CV bullet id copied into prose.
 * The drafter has no tools and no reviewer, so whatever it returns is what the recruiter reads: one
 * `[ADD BEFORE SENDING]` went out and the recruiter replied to say the email had a blank in it. A
 * plain-text application written properly carries no square brackets, so the shape is the rule.
 *
 * The id half arrived with tailoring. Ids ride in the prompt as `(r0.b3)` precisely so this regex cannot
 * reject the email over them, which leaves the model free to write one into a sentence; inside the CV
 * rule 5 catches it (masterText carries values, never ids), and the email had no equivalent guard. Only
 * the dotted bullet form is matched: a bare `r0` or `s1` collides with ordinary prose ("R2", "S1"), and
 * a false rejection here writes no row, so the post is retried and fails the same way every run.
 *
 * In code rather than in the procedure for the same reason gateOnPostType() is: the model follows a
 * written instruction most of the time, and "most of the time" is the failure. The prompt asks for a
 * complete email; this is what makes an incomplete one impossible to deliver.
 *
 * ponytail: a shape check on the one failure actually observed, not a completeness proof. It does not
 * catch `______`, `(please fill in)`, `<amount>` or a bare `N/A`. Widen it when a second shape is seen,
 * not before — a guess at the next shape costs a lead every time it is wrong, and the procedure already
 * tells the model to skip a post whose value it does not have.
 */
export const PLACEHOLDER = /\[[^\]\n]{0,120}\]|\b(?:TBD|TODO|FIXME|XXX)\b|\br\d+\.b\d+\b/i

/**
 * Guards the contract the database depends on: every requested post gets exactly one verdict, drafted posts
 * carry the `named in ...` prefix the follow-up query looks for, and at most one post carries the email.
 */
export function checkContract(req: DraftRequest, res: DraftResponse): string[] {
  const problems: string[] = []
  const asked = new Set(req.posts.map(p => p.key))
  const seen = new Set<string>()

  for (const r of res.results) {
    if (!asked.has(r.key)) problems.push(`result for a key that was not requested: ${r.key}`)
    if (seen.has(r.key)) problems.push(`duplicate result for ${r.key}`)
    seen.add(r.key)
    const prefix = req.mode === 'follow-up' ? 'named in follow-up' : 'named in application'
    if (r.verdict === 'drafted' && !r.reason.startsWith(prefix)) {
      problems.push(`drafted reason for ${r.key} must start with "${prefix}"`)
    }
  }
  for (const k of asked) if (!seen.has(k)) problems.push(`no verdict returned for ${k}`)

  const withBody = res.results.filter(r => r.body)
  if (withBody.length > 1) problems.push('more than one post carries an email body; expected one per recruiter')
  if (req.mode === 'apply' && withBody.length === 1 && !withBody[0]!.subject) {
    problems.push('the drafted email has a body but no subject')
  }

  // Fail closed: a draft with a hole in it is worse than no draft, because nothing downstream reviews it.
  for (const r of res.results) {
    for (const [field, value] of [['subject', r.subject], ['body', r.body]] as const) {
      const hit = value?.match(PLACEHOLDER)
      if (hit) problems.push(`the ${field} for ${r.key} still carries an unfilled placeholder or a CV id: ${hit[0]}`)
    }
  }
  return problems
}

export interface RunOptions {
  onLog?: (line: string) => void
  signal?: AbortSignal
  timeoutMs?: number
  /** Injected only when tailoring is on and fitsPromptBudget() holds — jobs.ts decides. */
  masterCv?: MasterCv | null
}

export function runDrafter(req: DraftRequest, config: AppConfig, opts: RunOptions = {}): Promise<DraftResponse> {
  const { onLog = () => {}, timeoutMs = 10 * 60_000 } = opts
  const args = [
    '-p',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--allowed-tools', 'NoToolsPermitted',
    '--disallowed-tools', ...DENY,
    '--append-system-prompt', buildSystemPrompt(config, opts.masterCv ?? null),
    '--output-format', 'text'
  ]

  const payload = JSON.stringify({
    mode: req.mode,
    chosen: req.chosen ?? false,
    recruiter_email: req.recruiterEmail,
    posts: req.posts.map(p => ({
      key: p.key, title: p.title, company: p.company, location: p.location,
      score: p.score, post_type: p.postType, flags: p.flags, text: p.text
    }))
  })

  return new Promise((resolvePromise, reject) => {
    onLog(`drafting for ${req.recruiterEmail} (${req.posts.length} post(s), mode=${req.mode})`)
    const child = spawn('claude', args, { cwd: neutralCwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`drafter timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })

    child.stdout.on('data', (c: Buffer) => {
      out += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString()
      c.toString().split('\n').filter(Boolean).forEach(onLog)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`could not start claude: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 300) || 'no stderr'}`))
      try {
        const parsed = parseResponse(out)
        const problems = checkContract(req, parsed)
        if (problems.length) return reject(new Error(`drafter broke the contract: ${problems.join('; ')}`))
        resolvePromise(parsed)
      } catch (e) {
        reject(e as Error)
      }
    })

    child.stdin.write(payload)
    child.stdin.end()
  })
}
