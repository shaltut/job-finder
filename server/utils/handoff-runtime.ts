// The server's view of the hand-off: paths from the environment, and the one state object the plugin,
// the endpoints and the boot pull share. On globalThis for the same reason __jobfinderRunner is — HMR
// inside one Nitro worker re-evaluates modules.
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { heartbeat, otherActive, pull, push, readLocalGen, readMeta, type HandoffPaths, type SyncMeta } from './handoff.ts'

export interface HandoffState {
  enabled: boolean
  host: string
  gen: number
  pushDisabled: string | null
  conflict: SyncMeta | null
  otherActive: boolean
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
  g.__jobfinderHandoff ??= {
    enabled: !!handoffPaths(), host: hostname(), gen: 0, pushDisabled: null, conflict: null,
    otherActive: false, lastPushAt: null, lastError: null, lastSig: ''
  }
  const s = g.__jobfinderHandoff
  const p = handoffPaths()
  if (p) {
    s.gen = readLocalGen(p.stateFile)
    s.otherActive = otherActive(readMeta(p.syncDir), s.host)
  }
  return s
}

/** Called from db.ts before the connection opens. */
export function bootPull() {
  const p = handoffPaths()
  if (!p) return
  const s = handoffState()
  const r = pull(p)
  if (r.error) {
    s.pushDisabled = `boot pull failed: ${r.error} — restart once OneDrive has finished syncing`
    console.error(`[sync] ${s.pushDisabled}`)
  } else if (r.pulled) {
    console.log(`[sync] pulled gen ${r.gen} from ${p.syncDir}`)
  }
  if (s.otherActive) console.warn('[sync] the other machine looks active — close it before working here')
}

export function pushNow(sig: string): HandoffState {
  const s = handoffState()
  const p = handoffPaths()
  if (!p || s.pushDisabled || s.conflict) return s
  try {
    const r = push(p, s.host)
    if (r.ok) {
      s.lastPushAt = new Date().toISOString()
      s.lastSig = sig
      s.lastError = null
    } else {
      s.conflict = r.conflict
      console.error(`[sync] ${r.conflict.host} pushed gen ${r.conflict.gen} since this machine pulled — not pushing; restart to pull it`)
    }
  } catch (e) {
    const msg = (e as Error).message
    // a forked folder is sticky (heartbeats stop too); a missing folder or an I/O error retries next tick
    if (msg.startsWith('conflict copy')) s.pushDisabled = msg
    else s.lastError = msg
    console.error(`[sync] ${msg}`)
  }
  return handoffState()
}

export function beat() {
  const p = handoffPaths()
  const s = handoffState()
  if (p && !s.pushDisabled && !s.conflict) {
    try {
      heartbeat(p, s.host)
    } catch (e) {
      s.lastError = (e as Error).message
    }
  }
}
