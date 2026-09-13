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

const SKILL_PATH = resolve(process.cwd(), '.claude/skills/job-application-drafter/SKILL.md')

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
  report: z.string().default('')
})

export type DraftResult = z.infer<typeof resultSchema>
export type DraftResponse = z.infer<typeof responseSchema>

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
    `Can start immediately: ${c.canStartImmediately ? 'yes' : 'no — he has a notice period'}`,
    `Acceptable working hours: ${c.workingHours}`,
    `Stack weighting: ${c.stackWeighting}`
  ].filter(Boolean).join('\n')
}

export function buildSystemPrompt(config: AppConfig): string {
  return `${profileBlock(config)}\n\n---\n\n${readFileSync(SKILL_PATH, 'utf8')}`
}

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
  return problems
}

export interface RunOptions {
  onLog?: (line: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export function runDrafter(req: DraftRequest, config: AppConfig, opts: RunOptions = {}): Promise<DraftResponse> {
  const { onLog = () => {}, timeoutMs = 10 * 60_000 } = opts
  const args = [
    '-p',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--allowed-tools', 'NoToolsPermitted',
    '--disallowed-tools', ...DENY,
    '--append-system-prompt', buildSystemPrompt(config),
    '--output-format', 'text'
  ]

  const payload = JSON.stringify({
    mode: req.mode,
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
