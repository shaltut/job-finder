import type { Place } from '../../shared/place'

export type Verdict = 'drafted' | 'skipped'
export type Stage = 'drafted' | 'contacted' | 'followed_up' | 'replied' | 'final'

/** A row from GET /api/posts: a scraped post plus the verdict, if it has one. */
export interface PostRow {
  key: string
  scrapedAt: string | null
  searchTerm: string | null
  author: string | null
  authorUrl: string | null
  postUrl: string | null
  postedAge: string | null
  /** 'hiring' | 'seeking' | 'other'; null on rows scored before the column existed. */
  postType: 'hiring' | 'seeking' | 'other' | null
  postedAt: string | null
  title: string | null
  company: string | null
  location: string | null
  remote: boolean | null
  inScope: boolean | null
  /** The standardized location (shared/place.ts), computed per page by the API. */
  place: Place
  emails: string[]
  /** External links on the card. An opaque `lnkd.in` hash, usually — see `channels` for what is usable. */
  links: string[]
  phones: string[]
  refIds: string[]
  /** The contact routes this post really offers: the subset of the three above worth acting on. */
  channels: ('email' | 'link' | 'phone')[]
  score: number | null
  reason: string | null
  text: string
  flags: string[]
  /** ISO timestamp when the owner dismissed this post; null means it is still live. */
  dismissedAt: string | null
  /** ISO timestamp when the owner applied by hand, through the post's link or number; null if not. */
  appliedAt: string | null
  verdict: Verdict | null
  verdictReason: string | null
  /** The recruiter's stage in `contacts`, by the post's first address; null if never written to. */
  stage: Stage | null
}

export interface Stats {
  total: number
  usable: number
  unprocessed: number
  last24h: number
  drafted: number
  lastScrapeAt: string | null
}

export type Lane = 'scrape' | 'draft' | 'paste' | 'gaps'
export type JobKind = 'scrape' | 'rescore' | 'reflag' | 'reextract' | 'draft' | 'sync' | 'paste' | 'gaps'

export interface JobView {
  id: number
  lane: Lane
  kind: JobKind
  args: Record<string, unknown>
  startedAt: string
  endedAt: string | null
  exit: number | null
  running: boolean
  added: number
  /** --reflag only: how many stored posts the exclude list now catches. */
  excluded: number | null
  log: string[]
}

export interface QueueItem {
  id: number
  lane: Lane
  kind: JobKind
  args: Record<string, unknown>
  queuedAt: string
}

/** GET /api/sync — the cross-machine hand-off (server/utils/handoff-runtime.ts). */
export interface SyncState {
  enabled: boolean
  host: string
  gen: number
  /** null while the folder holds no sync.json — Sync now then seeds it, and only on that press */
  remoteGen: number | null
  pushDisabled: string | null
  conflict: { gen: number, host: string } | null
  otherActive: boolean
  lastPushAt: string | null
  lastError: string | null
}

export interface JobState {
  lanes: Record<Lane, { current: JobView | null, last: JobView | null }>
  queue: QueueItem[]
  busy: boolean
}

export interface YieldRow {
  term: string
  posts: number
  usable: number
  drafted: number
}

// The profile, constraints and search settings. These used to be declared here by hand as a third
// copy of the same shape — one in the server's Zod schema, one in scraper/lib.ts, one here, kept in
// sync by nobody. shared/settings.ts is now the single definition and this re-exports it.
export type { AppConfig, Constraints, Profile } from '#shared/settings'

/** What Settings still needs before a scrape or a draft will start — GET /api/settings/status. */
export interface SettingsStatus {
  missing: string[]
  ready: boolean
  cv: string
  cvExists: boolean
}

export interface StoredDraft {
  recruiterEmail: string
  mode: 'apply' | 'follow-up'
  subject: string | null
  body: string
  signature: string
  keys: string[]
  gaps: string[]
  createdAt: string
}

export interface Contact {
  email: string
  stage: Stage
  threadId: string | null
  lastSentAt: string | null
  note: string | null
  updatedAt: string
}

export interface GmailStatus {
  configured: boolean
  authorized: boolean
  email: string | null
  expected: string | null
  mismatch: boolean
  redirect: string
}
