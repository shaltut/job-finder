export type Verdict = 'drafted' | 'skipped'
export type Stage = 'drafted' | 'contacted' | 'followed_up' | 'replied' | 'final'

/** A row from GET /api/posts: a scraped post plus the verdict, if it has one. */
export interface PostRow {
  key: string
  scrapedAt: string | null
  searchTerm: string | null
  author: string | null
  authorUrl: string | null
  postedAge: string | null
  postedAt: string | null
  title: string | null
  company: string | null
  location: string | null
  remote: boolean | null
  inScope: boolean | null
  emails: string[]
  score: number | null
  reason: string | null
  text: string
  flags: string[]
  verdict: Verdict | null
  verdictReason: string | null
}

export interface Stats {
  total: number
  usable: number
  unprocessed: number
  last24h: number
  drafted: number
  lastScrapeAt: string | null
}

export type Lane = 'scrape' | 'draft'
export type JobKind = 'scrape' | 'rescore' | 'reflag' | 'draft' | 'sync'

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
  log: string[]
}

export interface QueueItem {
  id: number
  lane: Lane
  kind: JobKind
  args: Record<string, unknown>
  queuedAt: string
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

export interface Profile {
  name: string
  title: string
  location: string
  email: string
  phone: string
  linkedin: string
  github: string
  languages: string
  yearsExperience: string
}

export interface Constraints {
  remoteAnywhere: boolean
  onsiteCountries: string[]
  willRelocate: string[]
  canStartImmediately: boolean
  workingHours: string
  stackWeighting: 'vue-primary' | 'equal' | 'react-primary'
}

export interface AppConfig {
  profile: Profile
  constraints: Constraints
  cv: string
  terms: string[]
  titles: string[]
  max: number
  since: 'past-24h' | 'past-week' | 'past-month'
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
