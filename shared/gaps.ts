// The Gaps page's model: the response shape of GET /api/gaps and the rules that turn statuses into
// groups. Pure and import-free, like shared/paste-poll.ts, so the page, the server and node:test all read
// one definition.

export type GapStatus = 'present' | 'partial' | 'absent'

/** learn: the CV does not show it. add: the experience is there, the keyword is not. on-cv: both are. */
export type GapGroup = 'learn' | 'add' | 'on-cv'

export interface GapPost {
  key: string
  title: string | null
  company: string | null
  postUrl: string | null
  importance: 'must' | 'nice'
  status: GapStatus
  /** the post's own words */
  quote: string
  /** the CV's own words; '' when absent */
  cvShows: string
  /** ISO date of the application */
  appliedAt: string | null
}

export interface GapTerm {
  term: string
  category: string
  group: GapGroup
  /** distinct applications asking */
  applications: number
  /** of those, how many make it a must-have */
  must: number
  lastSeen: string | null
  posts: GapPost[]
}

export interface GapsResponse {
  terms: GapTerm[]
  applications: number
  /** applications whose run carries the current CV's sha */
  analysed: number
}

/** The most frequent status; a tie goes to the worse one, so a split verdict never hides a gap. */
export function modeStatus(statuses: GapStatus[]): GapStatus {
  const n: Record<GapStatus, number> = { present: 0, partial: 0, absent: 0 }
  for (const s of statuses) n[s]++
  // worst first, replaced only by a strictly larger count
  return (['absent', 'partial', 'present'] as const).reduce((best, s) => (n[s] > n[best] ? s : best))
}

export function groupFor(status: GapStatus, inCv: boolean): GapGroup {
  if (status === 'absent') return 'learn'
  return inCv ? 'on-cv' : 'add'
}

const line = (t: GapTerm) =>
  `- ${t.term} — ${t.applications} application${t.applications === 1 ? '' : 's'} (${t.must} must-have)`

/** The copyable list, in the order given (already ranked). On your CV is left out: nothing to change. */
export function keywordList(terms: GapTerm[]): string {
  const section = (title: string, group: GapGroup) => {
    const ts = terms.filter(t => t.group === group)
    return ts.length ? [title, ...ts.map(line)].join('\n') : ''
  }
  return [
    section('Add now — you have it, your CV doesn\'t say it', 'add'),
    section('Learn — not on your CV yet', 'learn')
  ].filter(Boolean).join('\n\n')
}
