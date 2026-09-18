// The pure half of the paste intake: what a pasted post yields, and whether it is admitted.
// Deliberately free of `openai`, `node:fs` and the database so test/paste.test.ts can import it
// directly — server/utils/jobs.ts cannot be imported by a test, and this logic must be.
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
