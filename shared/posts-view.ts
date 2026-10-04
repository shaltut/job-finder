// The Posts view's state as a pure value: what the URL holds, what the API is asked, which filters show
// as chips. Kept out of index.vue so `node --test` can pin it (there is no Vue test setup here), the same
// reason shared/paste-poll.ts exists. Must not import server/: the browser bundles this file.

export const SORTS = ['default', 'score', 'title', 'posted', 'added'] as const // = server/utils/posts-query.ts
export type Sort = typeof SORTS[number]
export type Dir = 'asc' | 'desc'

type Opt<T> = { label: string, value: T }
const opts = <T extends string | number>(...o: [string, T][]): Opt<T>[] => o.map(([label, value]) => ({ label, value }))
const RANGE = opts<number>(['Any time', 0], ['24h', 1], ['3 days', 3], ['This week', 7], ['This month', 30])

export const OPTIONS = {
  status: opts(['Unprocessed', 'unprocessed'], ['All active', 'all'], ['Drafted', 'drafted'], ['Skipped', 'skipped'],
    ['Applied by hand', 'applied'], ['Dismissed', 'dismissed']),
  type: opts(['Hiring only', 'hiring'], ['Any post type', 'all'], ['Not hiring', 'other']),
  flags: opts(['Unflagged', 'clean'], ['Any flags', 'all'], ['Flagged only', 'flagged'], ['Excluded', 'excluded']),
  scope: opts(['Anywhere', 'all'], ['In scope', 'in-scope'], ['Remote', 'remote']),
  channel: opts(['Any contact', 'all'], ['By email', 'email'], ['By link', 'link'], ['By phone', 'phone']),
  minScore: opts<number>(['Any score', 0], ['6+', 6], ['8+', 8]),
  posted: RANGE,
  added: RANGE
}

type OptValue<K extends keyof typeof OPTIONS> = typeof OPTIONS[K][number]['value']
export type Status = OptValue<'status'>
export type PostType = OptValue<'type'>
export type Flags = OptValue<'flags'>
export type Scope = OptValue<'scope'>
export type Channel = OptValue<'channel'>

export interface PostsView {
  q: string
  status: Status
  type: PostType
  flags: Flags
  scope: Scope
  channel: Channel
  minScore: number
  posted: number
  added: number
  country: string[]
  countryMode: 'include' | 'exclude'
  sort: Sort
  dir: Dir
  page: number
}

/** The pre-grid defaults — a bare `/` must look exactly as it did before. */
export const DEFAULT_VIEW: PostsView = {
  q: '',
  status: 'unprocessed',
  type: 'hiring',
  flags: 'clean',
  scope: 'all',
  channel: 'all',
  minScore: 0,
  posted: 0,
  added: 0,
  country: [],
  countryMode: 'exclude',
  sort: 'default',
  dir: 'desc',
  page: 1
}

export const FIELD_LABEL: Record<keyof typeof OPTIONS, string> = {
  status: 'Status',
  type: 'Type',
  flags: 'Flags',
  scope: 'Where',
  channel: 'Contact',
  minScore: 'Score',
  posted: 'Posted',
  added: 'Added'
}

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v)
const str = (v: unknown) => (typeof first(v) === 'string' ? (first(v) as string).trim() : '')

function pickOpt<K extends keyof typeof OPTIONS>(key: K, raw: unknown): OptValue<K> {
  const s = str(raw)
  const hit = (OPTIONS[key] as Opt<string | number>[]).find(o => String(o.value) === s)
  return (hit ? hit.value : DEFAULT_VIEW[key]) as OptValue<K>
}

/** URL query → view. Every bad or missing key falls back to its default on its own. */
export function parseView(query: Record<string, unknown>): PostsView {
  const page = Number.parseInt(str(query.page), 10)
  const sort = str(query.sort)
  const country = (Array.isArray(query.country) ? query.country : [query.country])
    .filter((c): c is string => typeof c === 'string').map(c => c.trim()).filter(Boolean)
  return {
    q: str(query.q),
    status: pickOpt('status', query.status),
    type: pickOpt('type', query.type),
    flags: pickOpt('flags', query.flags),
    scope: pickOpt('scope', query.scope),
    channel: pickOpt('channel', query.channel),
    minScore: pickOpt('minScore', query.minScore),
    posted: pickOpt('posted', query.posted),
    added: pickOpt('added', query.added),
    country,
    countryMode: str(query.countryMode) === 'include' ? 'include' : 'exclude',
    sort: (SORTS as readonly string[]).includes(sort) ? sort as Sort : 'default',
    dir: str(query.dir) === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page >= 1 ? page : 1
  }
}

/** View → URL query: only what differs from the default, so a default view is a bare `/`. */
export function viewQuery(v: PostsView): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const k of Object.keys(DEFAULT_VIEW) as (keyof PostsView)[]) {
    if (k === 'country') {
      if (v.country.length) out.country = v.country
      continue
    }
    if (v[k] !== DEFAULT_VIEW[k]) out[k] = String(v[k])
  }
  if (!v.country.length) delete out.countryMode
  return out
}

/** View → /api/posts query: every filter, paging as limit/offset. */
export function apiQuery(v: PostsView, pageSize: number): Record<string, string | number | string[]> {
  const { page, ...rest } = v
  return { ...rest, limit: pageSize, offset: (page - 1) * pageSize }
}

/** Each filter's "show everything" value. */
const UNFILTERED: { [K in keyof typeof OPTIONS]: OptValue<K> } = {
  status: 'all', type: 'all', flags: 'all', scope: 'all', channel: 'all', minScore: 0, posted: 0, added: 0
}

/**
 * Whether a column's filter hides posts — what its header mark and the chip row show. Compared with
 * "show everything", not with the default: Unprocessed, Hiring only and Unflagged are defaults that
 * filter, and comparing with the default made a bare page look unfiltered.
 */
export function narrows<K extends keyof typeof OPTIONS>(field: K, value: OptValue<K>): boolean {
  return value !== UNFILTERED[field]
}

/** A chip's ✕: remove this filter. Not "back to the default" — for a default filter that changes nothing. Reset restores the defaults. */
export function liftFilter<K extends keyof typeof OPTIONS>(field: K): OptValue<K> {
  return UNFILTERED[field]
}

/** Every filter that hides posts, defaults included, labelled for the chip row. Search and sort are not chips. */
export function activeChips(v: PostsView): { key: keyof PostsView, label: string }[] {
  const out: { key: keyof PostsView, label: string }[] = []
  for (const k of Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]) {
    if (!narrows(k, v[k])) continue
    const o = (OPTIONS[k] as Opt<string | number>[]).find(x => x.value === v[k])
    out.push({ key: k, label: `${FIELD_LABEL[k]}: ${o?.label ?? String(v[k])}` })
  }
  if (v.country.length) {
    out.push({ key: 'country', label: `Country: ${v.countryMode === 'exclude' ? 'not ' : ''}${v.country.join(', ')}` })
  }
  return out
}

/** Header click: a new column starts descending; the same column goes desc → asc → back to default. */
export function nextSort(cur: { sort: Sort, dir: Dir }, col: Exclude<Sort, 'default'>): { sort: Sort, dir: Dir } {
  if (cur.sort !== col) return { sort: col, dir: 'desc' }
  return cur.dir === 'desc' ? { sort: col, dir: 'asc' } : { sort: 'default', dir: 'desc' }
}

/** Shift-click: every key from the anchor to the target, inclusive. An anchor no longer on the page is ignored. */
export function rangeKeys(keys: string[], anchor: string | null, target: string): string[] {
  const a = anchor ? keys.indexOf(anchor) : -1
  const t = keys.indexOf(target)
  if (a < 0 || t < 0) return [target]
  return keys.slice(Math.min(a, t), Math.max(a, t) + 1)
}

/** The page to show for `total` rows: a page past the end (a stale bookmark, a list that shrank) is the last one. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)))
}

/**
 * Whether bulk Draft belongs in this view. It is screened — only posts with no verdict are drafted — so
 * in Skipped or Drafted every selected row would be left out, and Dismissed / Applied undo instead.
 */
export function bulkDraftable(status: Status): boolean {
  return status === 'unprocessed' || status === 'all'
}
