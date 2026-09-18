// The pure half of the paste intake: what a pasted post yields, and whether it is admitted.
// Deliberately free of `openai`, `node:fs` and the database so test/paste.test.ts can import it
// directly — server/utils/jobs.ts cannot be imported by a test, and this logic must be.
// `pasteOnce` below isn't pure — it awaits a score and writes a row — but it takes those effects as
// arguments for the same reason: a test can inject them without touching OpenAI or SQLite.
import {
  admits, channelsOf, dedupeKey, extractEmails, extractLinks, extractPhones, extractRefIds, prescreen
} from '../../scraper/lib.ts'
import type { Config } from '../../scraper/lib.ts'
import type { Score } from '../../scraper/score.ts'
import type { PostRecord } from './ingest.ts'

/** Marks the origin without colonising a real search term in the per-term yield table. */
export const PASTED_TERM = 'pasted'

export interface PasteFound { emails: string[], links: string[], phones: string[], refIds: string[] }

export type PasteGate
  = | { ok: true, key: string, found: PasteFound, channels: string[] }
    | { ok: false, found: PasteFound, channels: string[], enabled: readonly string[] }

export function pasteGate(text: string, config: Config): PasteGate {
  const found: PasteFound = {
    emails: extractEmails(text),
    links: extractLinks(text),
    phones: extractPhones(text),
    refIds: extractRefIds(text)
  }
  const channels = channelsOf(found, text)
  const enabled = config.contactChannels
  if (!admits(channels, enabled)) return { ok: false, found, channels, enabled }
  // An empty author URL: a paste has no author, and two pastes of the same text must give one key.
  return { ok: true, key: dedupeKey('', text), found, channels }
}

export function pasteRecord(
  text: string,
  config: Config,
  gate: Extract<PasteGate, { ok: true }>,
  score: Score
): PostRecord {
  return {
    key: gate.key,
    searchTerm: PASTED_TERM,
    author: null,
    authorUrl: null,
    postUrl: null,
    postedAge: null,
    postedAt: null,
    postType: score.post_type,
    title: score.title,
    company: score.company,
    location: score.location,
    remote: score.is_remote,
    inScope: score.is_in_scope,
    emails: gate.found.emails,
    links: gate.found.links,
    phones: gate.found.phones,
    refIds: gate.found.refIds,
    channels: gate.channels,
    score: score.score,
    reason: score.reason,
    text,
    flags: prescreen(text, config)
  }
}

/**
 * The orchestration itself, injected rather than hardcoded: a source-text assertion over
 * paste-job.ts kept failing to pin down "a failed score must propagate, never fall through to a
 * fabricated one" — a try/catch passed the first regex, a `.catch()` passed the second. Testing the
 * real dependencies (OpenAI, SQLite) would fix that at the cost of every test paying for both, so the
 * effects are parameters instead. Nothing here catches around deps.score(): a throw is runJob's to
 * handle, and that omission is the whole property this function exists to make testable.
 */
export interface PasteDeps {
  system: () => Promise<string>
  score: (text: string, system: string) => Promise<Score>
  /** true when a row was inserted, false when the key was already present */
  store: (rec: PostRecord) => boolean
}

export async function pasteOnce(
  text: string,
  config: Config,
  deps: PasteDeps,
  push: (line: string) => void
): Promise<number> {
  const gate = pasteGate(text, config)
  if (!gate.ok) {
    // The endpoint refuses these synchronously; reaching here means the settings changed while queued.
    push(`refused: no enabled contact route (found ${gate.channels.join(', ') || 'none'})`)
    return 1
  }
  const system = await deps.system()
  const score = await deps.score(text, system)
  const rec = pasteRecord(text, config, gate, score)
  const applied = deps.store(rec)
  push(applied
    ? `stored: ${rec.title || 'untitled'} — score ${rec.score}, ${rec.postType}${rec.flags.length ? `, flags: ${rec.flags.join(' ')}` : ''}`
    : 'already stored: this post is already in the database')
  return 0
}
