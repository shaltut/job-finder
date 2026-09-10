// Job runner: two lanes, each sequential, fed by one queue.
//
//   scrape lane — Chrome holds a lock on ./profile, so one scrape at a time.
//   draft  lane — `claude -p` sessions (drafts, syncs), one at a time.
//
// The two lanes run concurrently; everything else queues, so POST /api/run/* returns 202 and never 409.
// Single-post draft requests waiting in the queue are batched into one claude session, because every
// session pays 3-5 minutes of setup regardless of how many posts it handles.
import { spawn, type ChildProcess } from 'node:child_process'
import { applyRecord, openWritableDb, type ScraperRecord } from './ingest'

export type Lane = 'scrape' | 'draft'
export type Kind = 'scrape' | 'rescore' | 'reflag' | 'draft' | 'sync'

export interface JobArgs {
  terms?: string
  max?: number
  since?: string
  /** draft lane: a single post, or a batch of them after the queue is coalesced */
  key?: string
  keys?: string[]
  n?: number
  /** set on jobs started by the daily tick, so they notify when they finish */
  auto?: boolean
}

interface Job {
  id: number
  lane: Lane
  kind: Kind
  args: JobArgs
  startedAt: string
  endedAt: string | null
  exit: number | null
  log: string[]
  added: number
  child: ChildProcess | null
}

interface QueueItem { id: number, lane: Lane, kind: Kind, args: JobArgs, queuedAt: string }

interface RunnerState {
  lanes: Record<Lane, { current: Job | null, last: Job | null }>
  queue: QueueItem[]
  seq: number
}

// Held on globalThis, not in module scope. Nitro's dev server hot-reloads this module whenever any
// server file is edited, and a fresh module would forget a scrape that is still running: the child
// keeps writing rows while the UI shows an idle lane and Stop has nothing to kill. Editing settings
// mid-scrape is normal use, so the state has to outlive the module.
const g = globalThis as typeof globalThis & { __jobfinderRunner?: RunnerState }
const state: RunnerState = g.__jobfinderRunner ??= {
  lanes: { scrape: { current: null, last: null }, draft: { current: null, last: null } },
  queue: [],
  seq: 0
}
const { lanes, queue } = state

const laneOf = (kind: Kind): Lane => (kind === 'scrape' || kind === 'rescore' || kind === 'reflag' ? 'scrape' : 'draft')
export const busy = () => !!(lanes.scrape.current || lanes.draft.current)

export function enqueue(kind: Kind, args: JobArgs = {}): QueueItem | null {
  // the same post queued twice, or a second sync, is a no-op rather than a duplicate session
  if (kind === 'draft' && args.key
    && (queue.some(q => q.args.key === args.key) || lanes.draft.current?.args?.keys?.includes(args.key))) return null
  if (kind === 'sync' && (queue.some(q => q.kind === 'sync') || lanes.draft.current?.kind === 'sync')) return null

  const item: QueueItem = { id: ++state.seq, lane: laneOf(kind), kind, args, queuedAt: new Date().toISOString() }
  queue.push(item)
  pump()
  return item
}

function pump() {
  for (const lane of Object.keys(lanes) as Lane[]) {
    if (lanes[lane].current) continue
    const idx = queue.findIndex(q => q.lane === lane)
    if (idx < 0) continue
    let item = queue.splice(idx, 1)[0]!
    if (item.kind === 'draft' && item.args.key) {
      // drain every other single-post draft request into this one session
      const more = queue.filter(q => q.kind === 'draft' && q.args.key)
      more.forEach(q => queue.splice(queue.indexOf(q), 1))
      item = { ...item, args: { keys: [item.args.key, ...more.map(q => q.args.key!)] } }
    }
    runJob(lane, item)
  }
}

/** node --env-file-if-exists=.env scraper/run.ts [...] */
function scrapeArgs({ kind, args }: { kind: Kind, args: JobArgs }): [string, string[]] {
  const a = ['--env-file-if-exists=.env', 'scraper/run.ts']
  if (kind === 'rescore') a.push('--rescore')
  else if (kind === 'reflag') a.push('--reflag')
  else {
    if (args.terms) a.push('--terms', args.terms)
    if (args.max) a.push('--max', String(args.max))
    if (args.since) a.push('--since', args.since)
  }
  return [process.execPath, a]
}

function runJob(lane: Lane, item: QueueItem) {
  const { kind, args } = item
  const job: Job = {
    id: item.id, lane, kind, args,
    startedAt: new Date().toISOString(), endedAt: null, exit: null,
    log: [], added: 0, child: null
  }
  lanes[lane].current = job

  const push = (line: string) => {
    job.log.push(line)
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400)
  }
  const pushChunk = (chunk: Buffer) => chunk.toString().split('\n').filter(Boolean).forEach(push)

  const finish = (code: number | null) => {
    job.exit = code
    job.endedAt = new Date().toISOString()
    job.child = null
    lanes[lane].current = null
    lanes[lane].last = job
    if (args.auto) notify(job.log.at(-1) || `${kind} finished, exit ${code}`)
    pump()
  }

  if (lane === 'draft') {
    // M3 wires `claude -p` in here. Until then the lane exists but refuses work loudly rather than
    // pretending to succeed.
    push('the drafter is not wired up yet (M3)')
    return finish(1)
  }

  const [cmd, cmdArgs] = scrapeArgs({ kind, args })
  // quote args containing spaces, or the log implies a different command than the one that ran
  push(`$ ${cmd} ${cmdArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)

  const child = spawn(cmd, cmdArgs, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  job.child = child

  // stdout is NDJSON and never reaches the log; the server is the only writer of the database.
  const { db, close } = openWritableDb()
  let buf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as ScraperRecord
        if (applyRecord(db, rec)) job.added++
      } catch {
        push(`ignored unparseable output: ${line.slice(0, 120)}`)
      }
    }
  })
  // stderr is the human-readable progress the Run view shows
  child.stderr.on('data', pushChunk)

  child.on('error', (e) => {
    push(`spawn error: ${e.message}`)
    close()
    finish(-1)
  })
  child.on('close', (code) => {
    if (!job.child) return
    close()
    if (code === 2) push('LinkedIn rejected the session — run `npm run login` again')
    push(`${job.added} row(s) written`)
    finish(code)
  })
}

export function stopLane(lane: Lane): boolean {
  const cur = lanes[lane]?.current
  if (!cur?.child) return false
  // Playwright's own SIGTERM handler only closes Chrome, so the scraper keeps a `stopping` flag and
  // throws at the next loop check.
  cur.child.kill('SIGTERM')
  return true
}

export function cancelQueued(id: number): boolean {
  const i = queue.findIndex(q => q.id === id)
  if (i < 0) return false
  queue.splice(i, 1)
  return true
}

const jobView = (j: Job | null) => j && {
  id: j.id, lane: j.lane, kind: j.kind, args: j.args,
  startedAt: j.startedAt, endedAt: j.endedAt, exit: j.exit,
  running: !!j.child, added: j.added, log: j.log
}

export const stateView = () => ({
  lanes: {
    scrape: { current: jobView(lanes.scrape.current), last: jobView(lanes.scrape.last) },
    draft: { current: jobView(lanes.draft.current), last: jobView(lanes.draft.last) }
  },
  queue,
  busy: busy()
})

export function notify(msg: string) {
  if (process.platform !== 'darwin') return
  import('node:child_process').then(({ execFile }) => {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(String(msg).slice(0, 200))} with title "Job Finder"`], () => {})
  })
}
