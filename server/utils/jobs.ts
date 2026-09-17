// Job runner: two lanes, each sequential, fed by one queue.
//
//   scrape lane — Chrome holds a lock on ./profile, so one scrape at a time.
//   draft  lane — `claude -p` sessions (drafts, syncs), one at a time.
//
// The two lanes run concurrently; everything else queues, so POST /api/run/* returns 202 and never 409.
// Single-post draft requests waiting in the queue are batched into one claude session, because every
// session pays 3-5 minutes of setup regardless of how many posts it handles.
import { spawn, type ChildProcess } from 'node:child_process'
import { readConfig, readConfigForDraft } from './config'
import { applicationAttachment } from './cv-attach'
import { loadMasterCv, type MasterCv } from './cv-master'
import { createCvRenderer } from './cv-render'
import { fitsPromptBudget, runDrafter, type DraftPost, type DraftRequest, type DraftResponse } from './drafter'
import { isClosed, persist, signature, writeDraftFile } from './drafts'
import { ccFrom, createDraft, gmailStatus, renderHtml } from './gmail'
import { applyRecord, openWritableDb, type ScraperRecord } from './ingest'
import { closedInGmail, sweep } from './sync'

export type Lane = 'scrape' | 'draft'
export type Kind = 'scrape' | 'rescore' | 'reflag' | 'reextract' | 'draft' | 'sync'

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
  /** --reflag only: how many stored posts the owner's exclude list now catches. */
  excluded: number | null
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

const laneOf = (kind: Kind): Lane => (kind === 'scrape' || kind === 'rescore' || kind === 'reflag' || kind === 'reextract' ? 'scrape' : 'draft')
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
  else if (kind === 'reextract') a.push('--reextract')
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
    log: [], added: 0, excluded: null, child: null
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
    // The drafter is an async pipeline, not a piped child: the server selects the posts, groups them by
    // recruiter and runs one claude session per group. `abort` gives Stop something to kill.
    const abort = new AbortController()
    job.child = { kill: () => abort.abort() } as unknown as ChildProcess
    const work = kind === 'sync' ? runSyncJob(push) : runDraftJob(job, args, push, abort.signal)
    work
      .then(code => finish(code))
      .catch((e) => {
        push(`failed: ${(e as Error).message}`)
        finish(1)
      })
    return
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
        // the one number the scraper knows and the database cannot be asked for afterwards: a
        // `flags=excluded` count would hide rows the owner had already dismissed by hand.
        if (rec.op === 'done' && typeof rec.excluded === 'number') job.excluded = rec.excluded
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
    // Not a broken session: the account is rate-limited and the scrape stopped itself rather than keep
    // asking. Nothing to fix; scraping again today only extends it.
    if (code === 3) push('LinkedIn paused search on this account (too many scrapes) — leave it until tomorrow')
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
  running: !!j.child, added: j.added, excluded: j.excluded, log: j.log
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

/**
 * One claude session per recruiter, not per post: the whole point of grouping is that a recruiter who
 * posted three roles gets one honest email naming all three, rather than three near-identical ones.
 */
async function runDraftJob(
  job: { added: number },
  args: JobArgs,
  push: (line: string) => void,
  signal: AbortSignal
): Promise<number> {
  const config = readConfigForDraft()
  const mail = gmailStatus(config.profile.email)
  const { db, close } = openWritableDb()
  // launches nothing until the first tailored CV is rendered
  const renderer = createCvRenderer()
  try {
    // The Posts view's Draft button, not the batch queue: pump() only ever coalesces single-post
    // requests with each other, so a `{ n }` job can never arrive carrying keys and vice versa.
    // That makes this the whole discriminator — no flag needs threading through the queue.
    const manual = !!args.keys?.length

    const rows = args.keys?.length
      // dismissed_at and applied_at here too, not just in the batch query below: the Posts view hides the
      // Draft button on both, but a tab left open beforehand must not be able to email about them.
      ? db.prepare(
          `SELECT p.* FROM posts p
           WHERE p.key IN (${args.keys.map(() => '?').join(',')})
             AND p.dismissed_at IS NULL AND p.applied_at IS NULL`
        ).all(...args.keys)
      // Flags and score exclude here rather than merely sorting last: this query decides who receives an
      // email from a real person's account. It is the 'usable' KPI minus its `(in_scope OR remote)` half —
      // deliberately, because the scorer leaves `location` unknown often enough that including it would
      // have dropped the one post that was legitimately drafted. So Usable can read 0 while this is not
      // empty; the drafter's own location hard skip is the gate for where a role actually is.
      : db.prepare(`
          SELECT p.* FROM posts p LEFT JOIN applications a ON a.key = p.key
          WHERE a.key IS NULL
            -- Was defensive while the scraper admitted a post only if it carried an address. Now that a
            -- post can be kept for its link or its number, this is the only thing between a link-only
            -- post and the contacts upsert, whose email column is NOT NULL and lower-case checked.
            AND json_array_length(p.emails) > 0
            AND coalesce(p.post_type, 'hiring') = 'hiring'
            AND json_array_length(p.flags) = 0
            AND p.score >= 6
            AND p.dismissed_at IS NULL
            AND p.applied_at IS NULL
          ORDER BY p.score DESC, p.posted_at DESC
          LIMIT ?
        `).all(args.n ?? 10)

    if (!rows.length) {
      push('nothing to draft: no unprocessed posts with a contact address')
      return 0
    }

    // Group by first email — one recruiter, one email. The other addresses on a post are not thrown
    // away: they become the Cc, because a post naming a second address is usually naming the person
    // who actually screens the CVs. The key stays emails[0] so `contacts` keeps one row per recruiter
    // and a Cc'd party never becomes a contact of their own, which would later earn them an email of
    // their own — the two-emails-ever ceiling counts recruiters, not addresses.
    const groups = new Map<string, DraftPost[]>()
    const groupEmails = new Map<string, string[][]>()
    for (const r of rows as Record<string, unknown>[]) {
      const emails = JSON.parse((r.emails as string) || '[]') as string[]
      const to = emails[0]?.toLowerCase()
      if (!to) continue
      const post: DraftPost = {
        key: r.key as string,
        title: r.title as string | null,
        company: r.company as string | null,
        location: r.location as string | null,
        score: r.score as number | null,
        postType: (r.post_type as DraftPost['postType']) ?? null,
        flags: JSON.parse((r.flags as string) || '[]'),
        text: r.text as string
      }
      groups.set(to, [...(groups.get(to) ?? []), post])
      groupEmails.set(to, [...(groupEmails.get(to) ?? []), emails])
    }
    push(`${rows.length} post(s) across ${groups.size} recruiter(s)`)

    // Tailoring, when switched on. The master CV loads once per job, and a failure only means this job
    // attaches the uploaded PDF — it must never stop a draft. The prompt budget is per job too: the master
    // CV and the config are both fixed for its duration.
    let master: MasterCv | null = null
    if (config.tailorCv) {
      try {
        master = await loadMasterCv(config.cv)
        if (!fitsPromptBudget(config, master)) {
          push('cv: master CV not injected — the prompt would exceed PROMPT_BUDGET; attaching the uploaded PDF')
          master = null
        }
      } catch (e) {
        push(`cv: master CV unavailable (${(e as Error).message}); attaching the uploaded PDF`)
      }
    }
    let tailoredCount = 0
    let fellBack = 0

    for (const [email, posts] of groups) {
      if (signal.aborted) {
        push('stopped')
        return 1
      }
      // Never a third email, and never edit a draft already waiting to be sent — but asked of Gmail, which
      // is the truth about who has been written to, rather than of `contacts`, which is only as fresh as
      // the last sweep. With no token there is no truth to ask and the cache is all there is, which keeps
      // the local-file draft path working on an install that has never seen Google Cloud.
      let closed: false | string
      try {
        closed = mail.authorized
          ? await closedInGmail(db, email, mail.email ?? config.profile.email)
          : isClosed(db, email)
      } catch (e) {
        // A network blip must not mark posts skipped: that verdict is permanent as far as this queue is
        // concerned. Writing no row leaves them unprocessed, the same posture as a drafter rejection.
        push(`${email}: could not reach Gmail to check the stage (${(e as Error).message}) — left for the next run`)
        continue
      }
      if (closed) {
        // Still a refusal when the owner chose the post — this is the two-emails-ever ceiling, not a
        // fit judgement, and the role rides in the follow-up instead. But it writes no row, so the
        // post stays live and visible rather than being buried by a decision the owner did not make.
        push(`${email}: ${closed}${manual ? ' — no email, and no row: the post stays live' : ' — skipping'}`)
        if (!manual) {
          for (const p of posts) {
            // A skip must never downgrade a post that an email already names: the M4 follow-up query finds
            // unmentioned posts by the `named in ...` prefix, so losing it would name the role twice.
            db.prepare(`
              INSERT INTO applications (key, verdict, reason, recruiter_email)
              VALUES (?, 'skipped', ?, ?)
              ON CONFLICT (key) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason
              WHERE applications.verdict <> 'drafted'
            `).run(p.key, closed, email)
          }
        }
        continue
      }

      const cc = ccFrom(groupEmails.get(email) ?? [], email, config.profile.email)
      const req: DraftRequest = { mode: 'apply', chosen: manual, recruiterEmail: email, posts }
      // One recruiter must not end the batch. The contract check now rejects an email carrying an unfilled
      // placeholder, which makes a rejection an ordinary event rather than a rare one. A rejection writes
      // NO applications row, so these posts stay `a.key IS NULL` and the next run picks them up again,
      // exactly as a failed score does. That is the difference from a skip: a skipped post does have a row
      // and never returns to this queue — it is re-drafted per post from the Posts view, which is the path
      // to use after filling in a setting the drafter said was missing.
      let res: DraftResponse
      try {
        res = await runDrafter(req, config, { onLog: push, signal, masterCv: master })
      } catch (e) {
        push(`${email}: ${(e as Error).message} — nothing drafted, the posts stay unprocessed and retry next run`)
        continue
      }

      const carrier = res.results.find(r => r.body)
      let ref: string | null = null
      let where = ''
      let tailoredPath: string | null = null
      if (carrier?.body) {
        const sig = signature(config.profile)
        const attachment = config.tailorCv
          ? await applicationAttachment({
              master, raw: res.cv, profile: config.profile, cvPath: config.cv, recruiterEmail: email, renderer
            })
          : null
        if (attachment) {
          push(`${email}: ${attachment.note}`)
          if (attachment.tailored) {
            tailoredCount++
            tailoredPath = attachment.path
          } else {
            fellBack++
          }
        }
        const attachPath = attachment?.path ?? config.cv
        // A Gmail draft when connected, a local file when not, so M1-M3 stay usable without Google Cloud.
        // Either way nothing is sent: the server has no code path that can send.
        if (gmailStatus().authorized) {
          const created = await createDraft({
            to: email,
            cc: cc.join(', ') || undefined,
            subject: carrier.subject,
            text: `${carrier.body}\n\n${sig}`,
            html: renderHtml(carrier.body, sig)
          }, attachPath)
          ref = created.id
          where = ` -> gmail draft ${created.id}${created.attachedBytes ? `, CV ${created.attachedBytes} bytes` : ', NO CV ATTACHED'}`
        } else {
          const file = writeDraftFile({
            recruiterEmail: email,
            cc,
            mode: 'apply',
            subject: carrier.subject ?? null,
            body: carrier.body,
            signature: sig,
            keys: res.results.filter(r => r.verdict === 'drafted').map(r => r.key),
            gaps: carrier.gaps_declared ?? [],
            cv: attachPath,
            createdAt: new Date().toISOString()
          })
          ref = file
          where = ` -> ${file.replace(process.cwd() + '/', '')}`
        }
      }

      const { drafted, skipped } = persist(db, req, res, ref, tailoredPath)
      job.added += drafted
      // "skipped" would be a lie on the manual path: nothing was recorded, so the post is still live
      // and the next bulk run will see it again. Say what actually happened to it.
      const passed = manual ? `${skipped} passed over (no verdict recorded)` : `${skipped} skipped`
      push(`${email}: ${drafted} drafted, ${passed}${where}`)
      if (res.report) res.report.split('\n').filter(Boolean).forEach(push)
    }
    if (config.tailorCv) push(`cv: ${tailoredCount} tailored, ${fellBack} fell back`)
    return 0
  } finally {
    // Neither close may depend on the other surviving. Closing the browser first meant a rejected
    // renderer.close() — a browser whose transport already died — leaked the sqlite handle, and a hung
    // one left runDraftJob's promise unsettled, so lanes.draft.current was never cleared and the draft
    // lane stayed wedged until a server restart: that state is on globalThis, so an HMR reload does not
    // clear it either. Started before close() and awaited after, with its rejection already handled.
    const closingBrowser = renderer.close().catch(() => {})
    close()
    await closingBrowser
  }
}

/**
 * The stage sweep: the follow-up engine, and the thing that refreshes `contacts` for the Pipeline view.
 * A drafter run does NOT call it — it asks Gmail per recruiter through closedInGmail() instead, which also
 * covers addresses `contacts` has never heard of.
 */
async function runSyncJob(push: (line: string) => void): Promise<number> {
  const config = readConfig()
  const status = gmailStatus(config.profile.email)
  if (!status.authorized) {
    push('gmail is not connected — open Settings and press Connect Gmail')
    return 1
  }
  if (status.mismatch) {
    // the sweep matches sent mail by sender; the wrong account makes every sent application look unsent
    push(`WARNING: connected as ${status.email} but Settings expects ${status.expected}`)
  }
  const { db, close } = openWritableDb()
  try {
    const lines = await sweep(db, config, status.email ?? config.profile.email, push)
    push(`sweep finished: ${lines.length} recruiter(s) checked`)
    return 0
  } finally {
    close()
  }
}
