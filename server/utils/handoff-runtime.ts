// The server's view of the hand-off: paths from the environment, and the one state object the plugin,
// the endpoints and the boot pull share. On globalThis for the same reason __jobfinderRunner is — HMR
// inside one Nitro worker re-evaluates modules.
import { hostname } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { bootRole, heartbeat, livePeer, livePull, nextStep, pull, push, readLocal, readLocalGen, readMeta, writeLocal, type HandoffPaths, type Peer, type Role, type SyncMeta } from './handoff.ts'

export interface HandoffState {
  enabled: boolean
  host: string
  gen: number
  /** this boot replaced the database with the other machine's — its queued jobs are not resumed here */
  pulled: boolean
  /** null while the folder holds no sync.json — then only an explicit init seeds it */
  remoteGen: number | null
  pushDisabled: string | null
  conflict: SyncMeta | null
  otherActive: boolean
  /** this machine's side of the lease: only `active` runs jobs, takes writes and pushes */
  role: Role
  /** when this machine last became the leader — the later of two leaders wins */
  since: string
  /** the other machine, from its heartbeat, while that is under 5 minutes old */
  peer: Peer | null
  lastPushAt: string | null
  lastError: string | null
  /** `data_version:total_changes` at the last push — see changeSig in db.ts for why both. */
  lastSig: string
}

const g = globalThis as { __jobfinderHandoff?: HandoffState }

export function handoffPaths(): HandoffPaths | null {
  const dir = process.env.JOBFINDER_SYNC_DIR
  if (!dir) return null
  const cwd = process.cwd()
  return {
    db: resolve(cwd, process.env.JOBFINDER_DB || 'data/jobfinder.db'),
    cvDir: resolve(cwd, 'data/cv'),
    stateFile: resolve(cwd, 'data/sync-state.json'),
    backupsDir: resolve(cwd, 'backups'),
    syncDir: dir
  }
}

export function handoffState(): HandoffState {
  const s = base()
  const p = handoffPaths()
  if (p) {
    s.gen = readLocalGen(p.stateFile)
    s.remoteGen = readMeta(p.syncDir)?.gen ?? null
    s.peer = livePeer(p.syncDir, s.host)
    s.otherActive = !!s.peer
  }
  return s
}

/** The state without touching the sync folder; the role comes back from data/sync-state.json after a worker rebuild. */
function base(): HandoffState {
  if (!g.__jobfinderHandoff) {
    const p = handoffPaths()
    const local = p ? readLocal(p.stateFile) : { gen: 0 }
    g.__jobfinderHandoff = {
      enabled: !!p, host: hostname(), gen: local.gen, pulled: false, remoteGen: null, pushDisabled: null, conflict: null,
      otherActive: false, role: (p && local.role) || 'active', since: local.since ?? '', peer: null,
      lastPushAt: null, lastError: null, lastSig: ''
    }
  }
  return g.__jobfinderHandoff
}

/** Whether this machine may run jobs and take writes. Always true with sync off. Cheap: no file reads. */
export const currentRole = (): Role => base().role
export const leading = () => currentRole() === 'active'

function setRole(s: HandoffState, role: Role, since = s.since) {
  if (role !== s.role) console.log(`[sync] ${s.role} → ${role}${s.peer ? ` (other machine: ${s.peer.host}, ${s.peer.role})` : ''}`)
  s.role = role
  s.since = since
  const p = handoffPaths()
  if (p) writeLocal(p.stateFile, { role, since })
}

/**
 * True only the first time this OS process asks. The Nitro dev server builds a new worker thread on every
 * server edit and starts it before the old one has terminated, so a pull there would replace — or unlink
 * the WAL of — a database the old worker still holds open. Worker threads share the pid; a real restart
 * does not. A file, because globalThis and process.env are per thread.
 */
export function firstBootInProcess(marker: string, pid = process.pid): boolean {
  try {
    if (readFileSync(marker, 'utf8').trim() === String(pid)) return false
  } catch { /* no marker yet */ }
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, String(pid))
  return true
}

/** Called from db.ts before the connection opens. */
export function bootPull() {
  const p = handoffPaths()
  if (!p) return
  const s = handoffState()
  if (!firstBootInProcess(resolve(process.cwd(), 'data/.boot-pid'))) return
  const r = pull(p)
  if (r.error) {
    s.pushDisabled = `boot pull failed: ${r.error} — restart once OneDrive has finished syncing`
    console.error(`[sync] ${s.pushDisabled}`)
  } else if (r.pulled) {
    s.pulled = true
    console.log(`[sync] pulled gen ${r.gen} from ${p.syncDir}`)
  }
  if (r.warning) {
    s.lastError = r.warning
    console.warn(`[sync] ${r.warning}`)
  }
  // the lease: a fresh process stands by while the other machine leads — it is how "I forgot the PC was
  // running" stops mattering. On a worker rebuild the role comes back from the state file instead.
  const peer = livePeer(p.syncDir, s.host)
  const role = bootRole(peer)
  setRole(s, role, role === 'active' ? new Date().toISOString() : s.since)
  if (role === 'standby') console.warn(`[sync] ${peer!.host} is leading — this machine is on standby; press Use this machine to take over`)
}

export function pushNow(sig: string, init = false): HandoffState {
  const s = handoffState()
  const p = handoffPaths()
  // only the leader publishes; a yielding one pushes its last changes from tick() itself
  if (p && s.role === 'active') publish(s, p, sig, init)
  return handoffState()
}

function publish(s: HandoffState, p: HandoffPaths, sig: string, init = false) {
  if (s.pushDisabled || s.conflict) return
  try {
    const r = push(p, s.host, new Date(), { init })
    if (r.ok) {
      s.gen = r.gen
      s.lastPushAt = new Date().toISOString()
      s.lastSig = sig
      s.lastError = null
    } else {
      // no longer sticky: the next tick yields, and the pull on standby clears it
      s.conflict = r.conflict
      console.error(`[sync] ${r.conflict.host} pushed gen ${r.conflict.gen} since this machine pulled — not pushing; standing by to pull it`)
    }
  } catch (e) {
    const msg = (e as Error).message
    // a forked folder is sticky; a missing folder or an I/O error retries next tick
    if (msg.startsWith('conflict copy')) s.pushDisabled = msg
    else s.lastError = msg
    console.error(`[sync] ${msg}`)
  }
}

function beat(s: HandoffState, p: HandoffPaths) {
  try {
    heartbeat(p, s.host, new Date(), { role: s.role, since: s.since, gen: readLocalGen(p.stateFile) })
  } catch (e) {
    s.lastError = (e as Error).message
  }
}

/** The Use-this-machine button. The take-over itself happens on the ticks that follow. */
export function claim(): HandoffState {
  const s = base()
  const p = handoffPaths()
  if (p && (s.role === 'standby' || s.role === 'claiming')) {
    setRole(s, 'claiming')
    beat(s, p)
  }
  return handoffState()
}

export interface TickDeps {
  live: Database.Database
  /** `data_version:total_changes` now (db.ts changeSig) */
  sig: () => string
  busy: () => boolean
  /** stop every lane and forget the queue — jobs.ts yieldAll */
  stopAll: () => number
  /** push the snapshot even if it is not yet two minutes since the last one */
  pushDue: boolean
}

/**
 * Every 30 s: read the other machine's heartbeat, take one step of the lease (handoff.ts nextStep), and
 * write this machine's heartbeat — on EVERY tick, whatever the role. It used to be written only on a tick
 * with nothing to push, so the busiest machine was exactly the one that looked idle to the other.
 */
export function tick(d: TickDeps) {
  const p = handoffPaths()
  if (!p) return
  const s = handoffState()
  const step = nextStep({ host: s.host, role: s.role, since: s.since, busy: d.busy(), localGen: s.gen, remoteGen: s.remoteGen }, s.peer)
  if (step.stop) console.log(`[sync] handing over: ${d.stopAll()} queued job(s) dropped, running ones stopped — queue them again on the leading machine`)
  if (step.finish && d.sig() !== s.lastSig) {
    // the last changes go out before standing down; a refused push (someone else published) already
    // saved them to backups/conflict-*.db, and the pull below keeps a copy of whatever is left
    publish(s, p, d.sig())
  }
  let role = step.role
  if (step.pull) {
    const r = livePull(d.live, p, { keep: d.sig() !== s.lastSig })
    if (r.error) {
      s.lastError = `pull: ${r.error}`
      role = s.role // leading needs the newer data first; retried next tick
    } else if (r.pulled) {
      s.gen = r.gen
      s.conflict = null
      s.lastError = null
      s.lastSig = d.sig()
      if (s.pushDisabled?.startsWith('boot pull failed')) s.pushDisabled = null // the snapshot has arrived since
      console.log(`[sync] pulled gen ${r.gen} live`)
    }
  }
  if (role !== s.role) setRole(s, role, step.since ?? s.since)
  if (s.role === 'active' && d.pushDue && d.sig() !== s.lastSig) pushNow(d.sig())
  beat(s, p)
}
