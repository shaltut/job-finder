<script setup lang="ts">
import { findFinishedMatch, stalePastes, type FinishedPasteJob } from '#shared/paste-poll'
import { activeChips, apiQuery, clampPage, DEFAULT_VIEW, nextSort, OPTIONS, parseView, rangeKeys, viewQuery, type PostsView } from '#shared/posts-view'
import { sentTo, STAGE_LABEL } from '#shared/recruiter-stage'
import type { TableColumn } from '@nuxt/ui'
import type { JobState, PostRow } from '~/types'

useDashboard()
useHead({ title: 'Posts' })

const { reflagAndWait } = useReflag()

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')
const UCheckbox = resolveComponent('UCheckbox')
const UDropdownMenu = resolveComponent('UDropdownMenu')
const UIcon = resolveComponent('UIcon')
const PostsHeaderCell = resolveComponent('PostsHeaderCell')
const URadioGroup = resolveComponent('URadioGroup')
const USelectMenu = resolveComponent('USelectMenu')
const USwitch = resolveComponent('USwitch')

const toast = useToast()
const queued = ref<Set<string>>(new Set())
const busy = ref(false)

async function draft(key: string) {
  queued.value = new Set([...queued.value, key])
  try {
    const r = await $fetch<{ queued: boolean, note?: string }>('/api/run/draft', { method: 'POST', body: { key } })
    toast.add({
      title: r.queued ? 'Drafting queued' : 'Already queued',
      description: r.queued ? 'Read it in the Pipeline view in ~30s.' : r.note,
      icon: 'i-lucide-pen-line'
    })
    drafting.add(key)
    draftTimer ??= setInterval(pollDraftLane, 3000)
  } catch (e) {
    queued.value = new Set([...queued.value].filter(k => k !== key))
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  }
}

/** Bulk Draft: screened, like the batch run — the drafter may skip, and the skip is recorded. */
async function draftSelected(keys: string[]) {
  if (!keys.length || busy.value) return
  busy.value = true
  try {
    const r = await $fetch<{ queued: boolean, note?: string }>('/api/run/draft', { method: 'POST', body: { keys } })
    rowSelection.value = {}
    toast.add({
      title: r.queued ? `Queued ${keys.length} selected post${keys.length > 1 ? 's' : ''}` : 'Already queued',
      description: r.queued
        ? 'Screened like the batch run: only unprocessed, unflagged hiring posts scoring 6+ with an address are drafted. The job log says how many.'
        : r.note,
      icon: 'i-lucide-pen-line'
    })
    keys.forEach(k => drafting.add(k))
    draftTimer ??= setInterval(pollDraftLane, 3000)
  } catch (e) {
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}

// Keys pressed here whose draft job has not finished. What the job leaves behind — a verdict, or the
// stage the Gmail gate wrote into `contacts` — only reaches the row when the list is fetched again, so
// refresh once a key is neither queued nor in the running job. A queued request carries `args.key`;
// pump() moves it into `args.keys` when the job starts, and a bulk Draft is queued with `args.keys`
// from the start, so both are checked. A separate set from
// `queued`, which any refresh clears (a filter change included) and would stop this poll early.
const drafting = new Set<string>()
let draftTimer: ReturnType<typeof setInterval> | null = null

async function pollDraftLane() {
  const s = await $fetch<JobState>('/api/job')
  const running = (s.lanes.draft.current?.args.keys ?? []) as string[]
  const done = [...drafting].filter(k => !running.includes(k)
    && !s.queue.some(q => q.args.key === k || (q.args.keys as string[] | undefined)?.includes(k)))
  if (!done.length) return
  done.forEach(k => drafting.delete(k))
  if (!drafting.size && draftTimer) {
    clearInterval(draftTimer)
    draftTimer = null
  }
  await Promise.all([refresh(), refreshNuxtData('stats')])
}

onUnmounted(() => {
  if (draftTimer) clearInterval(draftTimer)
})

// ---------------- paste ----------------

interface PasteEntry {
  at: number
  state: 'queued' | 'stored' | 'refused' | 'failed' | 'unknown'
  detail: string
  text: string
}

interface PasteRefusal {
  error?: string
  found?: { emails: number, links: number, phones: number }
  enabled?: string[]
}

const pasteText = ref('')
const pasting = ref(false)
const pastes = ref<PasteEntry[]>([])

const pasteReady = computed(() => pasteText.value.trim().length >= 40 && !pasting.value)

function describeRefusal(d: PasteRefusal | undefined): string {
  // `d` is undefined when $fetch never got a response at all (network down, dev server unreachable) —
  // distinct from a 5xx that did respond but without our endpoint's `{ error }` shape (an uncaught
  // exception, surfaced through Nitro's own generic error body instead). Neither is a real refusal —
  // the post was never even looked at — so neither may read as the bare word 'refused', which is what
  // pasteGate's actual "no contact route" answer looks like.
  if (d === undefined) return 'could not reach the server — check your connection and try again'
  if (!d.error) return 'the server returned an unexpected error — try again'
  if (!d.found) return d.error
  const { emails, links, phones } = d.found
  return `no contact route — ${emails} emails, ${links} links, ${phones} phones; you accept: ${(d.enabled || []).join(', ')}`
}

async function submitPaste() {
  const text = pasteText.value.trim()
  if (!text) return
  pasting.value = true
  try {
    const r = await $fetch<{ queued?: boolean, duplicate?: boolean, note?: string }>('/api/posts/paste', {
      method: 'POST',
      body: { text }
    })
    if (r.duplicate) {
      pastes.value.unshift({ at: Date.now(), state: 'refused', detail: 'you already have this post', text })
    } else if (r.queued === false) {
      // Identical text is already queued or running under another entry — a job the server coalesced
      // rather than a new one. A second 'queued' row for it would never resolve: pollPasteLane matches
      // by text, and one background job can only settle one row.
      const alreadyTracked = pastes.value.some(p => p.state === 'queued' && p.text === text)
      if (!alreadyTracked) {
        pastes.value.unshift({ at: Date.now(), state: 'queued', detail: r.note || 'already queued or running', text })
        startPastePolling()
      }
    } else {
      pastes.value.unshift({ at: Date.now(), state: 'queued', detail: 'queued for scoring', text })
      startPastePolling()
    }
    pasteText.value = '' // accepted, duplicate, or already in flight: nothing left to recover
  } catch (e) {
    // $fetch throws on a non-2xx and puts the parsed body on `.data`; there is no `.data.missing` —
    // the endpoint only ever returns `error` (plus `found`/`enabled` for the no-contact-route case).
    // `.data` left undefined (not defaulted to `{}`) so describeRefusal can tell "no response at all"
    // apart from "a response with no `error` field".
    const d = (e as { data?: PasteRefusal }).data
    pastes.value.unshift({ at: Date.now(), state: 'refused', detail: describeRefusal(d), text })
    // deliberately NOT cleared: a refused paste must not be lost
  } finally {
    pasting.value = false
  }
}

function pasteAgain(entry: PasteEntry) {
  pasteText.value = entry.text
}

function pasteBadgeColor(state: PasteEntry['state']): 'success' | 'neutral' | 'warning' | 'error' {
  if (state === 'stored') return 'success'
  if (state === 'queued') return 'neutral'
  if (state === 'unknown') return 'warning'
  return 'error'
}

let pasteTimer: ReturnType<typeof setInterval> | null = null

function stopPastePolling() {
  if (pasteTimer) {
    clearInterval(pasteTimer)
    pasteTimer = null
  }
}

function startPastePolling() {
  if (pasteTimer) return
  pasteTimer = setInterval(pollPasteLane, 2000)
}

/**
 * Poll only while something local is outstanding, and stop as soon as nothing is. Matching against the
 * lane's `last` finished job is `findFinishedMatch` (shared/paste-poll.ts, tested there directly) —
 * this function's own job is just the two effects a match or a stale entry has: refreshing the posts
 * list, and giving up on an entry that has waited past all reason so the interval can actually stop.
 */
async function pollPasteLane() {
  const queued = pastes.value.filter(p => p.state === 'queued')
  if (!queued.length) return stopPastePolling()

  // The staleness sweep and the stop-check run in `finally`, not after a straight-line return, so a
  // `$fetch` that keeps rejecting (the lane's own endpoint down, a network blip) cannot leak the
  // interval the same way an unmatched job once did — this function must reach the bottom either way.
  // Not caught here: an uncaught rejection from an interval callback is how the rest of this file polls
  // (see refreshJob() in run.vue/pipeline.vue), so this does not swallow the error, only reorders around it.
  try {
    const s = await $fetch<{ lanes: { paste?: { last: FinishedPasteJob | null } } }>('/api/job')
    const last = s.lanes.paste?.last ?? null
    const match = findFinishedMatch(queued, last)
    if (match && last) {
      const line = last.log.at(-1) || ''
      if (line.startsWith('stored:') || line.startsWith('already stored:')) {
        match.state = 'stored'
        match.detail = line
        await Promise.all([refresh(), refreshNuxtData('stats')])
      } else if (line) {
        match.state = 'failed'
        match.detail = line
      }
    }
  } finally {
    // A stuck entry (the lane's `last` slot was overwritten by a second job before a poll ever saw
    // this one finish) would otherwise hold `queued.length` at 1 forever, and the guard above would
    // never fire — the exact always-on interval Step 3 exists to prevent. Giving up after
    // PASTE_STALE_MS is what lets the interval stop even when the real outcome is unrecoverable.
    stalePastes(pastes.value.filter(p => p.state === 'queued'), Date.now()).forEach((p) => {
      p.state = 'unknown'
      p.detail = 'no result after several minutes — check the Posts list'
    })
    if (!pastes.value.some(p => p.state === 'queued')) stopPastePolling()
  }
}

onUnmounted(stopPastePolling)

// The whole view — filters, sort, page — lives in the URL (shared/posts-view.ts), so a refresh, the back
// button or a bookmark lands on the same list. A bare `/` is the pre-grid default.
const route = useRoute()
const router = useRouter()
const view = computed(() => parseView(route.query))

/** Every view change goes through here. Any change but the page itself returns to page 1. */
function setView(patch: Partial<PostsView>) {
  const next = { ...view.value, ...patch }
  if (!('page' in patch)) next.page = 1
  // Seekers carry the `seeking-work` flag, so asking for non-hiring posts under the default 'Unflagged'
  // would return only the unflagged non-jobs and hide the very rows this filter exists to show.
  if (patch.type === 'other') next.flags = 'all'
  router.replace({ query: viewQuery(next) })
}

// The search box types fast; the URL and the fetch follow 300ms behind.
const qInput = ref(view.value.q)
let qTimer: ReturnType<typeof setTimeout> | undefined
watch(qInput, (v) => {
  clearTimeout(qTimer)
  qTimer = setTimeout(() => setView({ q: v.trim() }), 300)
})
watch(() => view.value.q, (v) => {
  if (v !== qInput.value.trim()) qInput.value = v
})

const chips = computed(() => activeChips(view.value))
function clearChip(key: keyof PostsView) {
  setView(key === 'country' ? { country: [], countryMode: 'exclude' } : { [key]: DEFAULT_VIEW[key] })
}
/** Reset clears the filters; the search text and the sort are not filters and stay. */
function resetFilters() {
  router.replace({ query: viewQuery({ ...DEFAULT_VIEW, q: view.value.q, sort: view.value.sort, dir: view.value.dir }) })
}

const { data: countryOptions } = await useFetch<{ name: string, count: number }[]>('/api/posts/countries', {
  lazy: true,
  default: () => []
})

const expanded = ref<Record<string, boolean>>({})
const rowSelection = ref<Record<string, boolean>>({})
const anchorKey = ref<string | null>(null) // the last row clicked, for shift-click ranges
let shiftHeld = false

// Paged, because the server returns at most `limit` rows while reporting the full count: without this
// the header read "834 posts" over the top 100 by score, and nothing said the rest existed.
const PAGE_SIZE = 100
const page = computed({ get: () => view.value.page, set: (p: number) => setView({ page: p }) })
const offset = computed(() => (view.value.page - 1) * PAGE_SIZE)

const { data, status: reqStatus, refresh } = await useFetch<{ rows: PostRow[], total: number }>('/api/posts', {
  query: computed(() => apiQuery(view.value, PAGE_SIZE)),
  lazy: true,
  default: () => ({ rows: [], total: 0 })
})

// Pressing Draft disables the button so a double click cannot open two sessions; fresh rows are the
// signal it can be re-enabled. Safe either way — enqueue() treats a second request for a key that is
// already queued or running as a no-op, so this never needs "hardening" into something stickier.
watch(data, () => {
  queued.value = new Set()
})

// Selection is TanStack state keyed by post key (see :get-row-id), and it keeps the keys of rows that
// have since dropped out of `data` — a filter change would otherwise leave a bulk Dismiss pointed at
// posts nobody can see. Intersecting with the rows on screen is what makes "N selected" honest; the
// watch below is the second line of defence.
const selectedKeys = computed(() => data.value.rows.filter(r => rowSelection.value[r.key]).map(r => r.key))

// Any view change — filter, sort or page — drops the selection: a bulk action must never point at
// posts nobody can see.
watch(() => route.fullPath, () => {
  rowSelection.value = {}
  anchorKey.value = null
})

// Dismissing or marking applied every row on the last page leaves it past the end: step back a page
// rather than show an empty table under a count that says the posts exist.
// Also once on mount: the first page load is server-rendered, so `total` arrives already set and the
// watch alone never fires — a bookmarked ?page=2 after the list shrank stranded the owner on an empty
// table with the pager hidden. On the client only, where router.replace belongs.
function clampToTotal() {
  const p = clampPage(page.value, data.value.total, PAGE_SIZE)
  if (data.value.total > 0 && p !== page.value) page.value = p
}
watch(() => data.value.total, clampToTotal)
onMounted(clampToTotal)

const rangeLabel = computed(() => {
  const total = data.value.total
  return total <= PAGE_SIZE
    ? `${total} posts`
    : `${offset.value + 1}–${Math.min(offset.value + PAGE_SIZE, total)} of ${total} posts`
})

// The pager sits under the table, so a page change would otherwise land at the bottom of the new page.
const filterBar = useTemplateRef<HTMLElement>('filterBar')
watch(page, () => filterBar.value?.scrollIntoView({ block: 'start' }))

/**
 * Mark posts applied, or un-mark them. A post reachable only by link or number can never become a
 * draft, so this is how it leaves the queue — and it leaves it the same way a dismissal does.
 */
async function setApplied(keys: string[], applied: boolean, undoable = true) {
  if (!keys.length || busy.value) return
  busy.value = true
  try {
    await $fetch('/api/posts/applied', { method: 'POST', body: { keys, applied } })
    rowSelection.value = {}
    await Promise.all([refresh(), refreshNuxtData('stats')])
    toast.add({
      title: `${applied ? 'Marked applied' : 'Un-marked'} ${keys.length} post${keys.length > 1 ? 's' : ''}`,
      icon: applied ? 'i-lucide-check' : 'i-lucide-undo-2',
      actions: undoable
        ? [{
            label: 'Undo',
            color: 'neutral' as const,
            variant: 'outline' as const,
            onClick: () => setApplied(keys, !applied, false)
          }]
        : undefined
    })
  } catch (e) {
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}

/** Dismiss posts, or restore them — the same endpoint both ways, which is what makes Undo free. */
async function setDismissed(keys: string[], dismissed: boolean, undoable = true) {
  if (!keys.length || busy.value) return
  busy.value = true
  try {
    await $fetch('/api/posts/dismiss', { method: 'POST', body: { keys, dismissed } })
    rowSelection.value = {}
    await Promise.all([refresh(), refreshNuxtData('stats')])
    toast.add({
      title: `${dismissed ? 'Dismissed' : 'Restored'} ${keys.length} post${keys.length > 1 ? 's' : ''}`,
      icon: dismissed ? 'i-lucide-x' : 'i-lucide-undo-2',
      actions: undoable
        ? [{
            label: 'Undo',
            color: 'neutral' as const,
            variant: 'outline' as const,
            onClick: () => setDismissed(keys, !dismissed, false)
          }]
        : undefined
    })
  } catch (e) {
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  } finally {
    busy.value = false
  }
}

// ---------------- exclude ----------------

const excludeOpen = ref(false)
const excludeNeedle = ref('')
const excludeRow = ref<PostRow | null>(null)
/** bulk mode: the selection's distinct companies and recruiters, each ticked; excludeRow is null then */
const bulkNeedles = ref<{ value: string, on: boolean }[]>([])

/**
 * What the owner might plausibly mean by "never again", read off the row itself.
 *
 * Domains come from the post text rather than `links`, because LinkedIn rewrites almost every outbound
 * link to an opaque lnkd.in hash — the readable name only ever survives in the prose. That is exactly
 * how `jobs.micro1.ai` is visible at all.
 */
const excludeSuggestions = computed(() => {
  const r = excludeRow.value
  if (!r) return []
  const domains = [...(r.text ?? '').matchAll(/\b((?:[a-z0-9][a-z0-9-]*\.)+(?:ai|com|io|co|net|org|dev))\b/gi)]
    .map(m => m[1]!.toLowerCase())
    .filter(d => !d.includes('linkedin.') && !d.includes('lnkd.'))
  const out = [r.author, r.company && r.company !== 'unknown' ? r.company : '', ...domains]
  return [...new Set(out.map(v => (v ?? '').trim()).filter(v => v.length >= 2))].slice(0, 6)
})

/** Bulk Exclude: every distinct company and recruiter name on the selection, each ticked. */
function openBulkExclude() {
  const rows = data.value.rows.filter(r => rowSelection.value[r.key])
  const names = rows.flatMap(r => [r.company, r.author])
    .map(v => (v ?? '').trim())
    .filter(v => v.length >= 2 && v.toLowerCase() !== 'unknown')
  bulkNeedles.value = [...new Set(names)].map(value => ({ value, on: true }))
  excludeRow.value = null
  excludeOpen.value = true
}

/** The dialog's confirm: one typed needle from a row, or the ticked names from a selection. */
function confirmExclude() {
  return addExclude(excludeRow.value
    ? [excludeNeedle.value.trim()]
    : bulkNeedles.value.filter(n => n.on).map(n => n.value))
}

function openExclude(r: PostRow) {
  excludeRow.value = r
  excludeNeedle.value = r.author ?? ''
  excludeOpen.value = true
}

/** Save the rules in one request, then wait for the re-flag before refreshing — see useReflag for why. */
async function addExclude(needles: string[]) {
  needles = needles.filter(n => n.length >= 2)
  if (!needles.length || busy.value) return
  const what = needles.length === 1 ? `"${needles[0]}"` : `${needles.length} names`
  busy.value = true
  excludeOpen.value = false
  try {
    await $fetch('/api/settings/excludes', { method: 'POST', body: { needles } })
  } catch (e) {
    busy.value = false
    toast.add({ title: 'Not excluded', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
    return
  }

  // The rule is stored from here on, so a failure below is about the re-check, never about the rule.
  try {
    const { excluded } = await reflagAndWait({
      onQueued: () => toast.add({
        title: 'Re-check queued',
        description: 'A scrape is running — this will apply when it finishes.',
        icon: 'i-lucide-clock'
      })
    })
    rowSelection.value = {}
    await Promise.all([refresh(), refreshNuxtData('stats')])
    toast.add({
      title: `Excluding ${what}`,
      description: `${excluded} post${excluded === 1 ? '' : 's'} now excluded. Edit the list in Settings.`,
      icon: 'i-lucide-filter',
      color: 'success'
    })
  } catch {
    toast.add({
      title: `Excluding ${what}`,
      description: 'Saved, but stored posts were not re-checked. Press Reflag in the Run view.',
      color: 'warning',
      duration: 8000
    })
  } finally {
    busy.value = false
  }
}

/** A header cell: the label, an optional sort, and an optional one-field radio filter behind its button. */
function header(label: string, sortCol?: 'score' | 'title' | 'posted' | 'added', field?: keyof typeof OPTIONS) {
  return () => h(PostsHeaderCell, {
    label,
    sortCol,
    sort: view.value.sort,
    dir: view.value.dir,
    active: !!field && view.value[field] !== DEFAULT_VIEW[field],
    onSort: () => sortCol && setView(nextSort(view.value, sortCol))
  }, field
    ? {
        default: () => h(URadioGroup, {
          'modelValue': view.value[field],
          'items': OPTIONS[field],
          'onUpdate:modelValue': (v: string | number) => setView({ [field]: v } as Partial<PostsView>)
        })
      }
    : undefined)
}

/** What the Status badge reads — the codes are API values, not words for the owner. */
const STATUS_LABEL = { unprocessed: 'Unprocessed', drafted: 'Drafted', skipped: 'Skipped', applied: 'Applied', dismissed: 'Dismissed' }

const columns: TableColumn<PostRow>[] = [
  {
    id: 'select',
    header: ({ table }) => h(UCheckbox, {
      'modelValue': table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected(),
      'onUpdate:modelValue': (v: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(!!v),
      'aria-label': 'Select all'
    }),
    // Shift-click selects from the last row clicked. The capture handler runs before the checkbox's
    // update, so it records the modifier the update then reads.
    cell: ({ row }) => h('div', { onClickCapture: (e: MouseEvent) => { shiftHeld = e.shiftKey } }, [
      h(UCheckbox, {
        'modelValue': row.getIsSelected(),
        'onUpdate:modelValue': (v: boolean | 'indeterminate') => {
          const span = shiftHeld ? rangeKeys(data.value.rows.map(r => r.key), anchorKey.value, row.id) : [row.id]
          rowSelection.value = { ...rowSelection.value, ...Object.fromEntries(span.map(k => [k, !!v])) }
          anchorKey.value = row.id
          shiftHeld = false
        },
        'aria-label': 'Select row (shift-click for a range)'
      })
    ])
  },
  {
    id: 'actions',
    // Next to the checkbox, beside what the owner is reading. At the right edge the eye had to travel the
    // whole row from the title to Draft and back, and it was easy to press the button of the row above or
    // below. The left edge also never scrolls off-screen, which is what the old right-edge pinning was
    // for — and that pinning floated over Status at laptop widths.
    cell: ({ row }) => {
      const r = row.original
      return h('div', { class: 'flex items-center gap-1' }, [
        r.dismissedAt
          ? h(UButton, {
              label: 'Restore',
              icon: 'i-lucide-undo-2',
              size: 'xs',
              color: 'neutral',
              variant: 'outline',
              disabled: busy.value,
              onClick: () => setDismissed([r.key], false)
            })
          : null,
        // no second email to a recruiter already handled, nothing to draft without an address, and
        // nothing to draft for a role the owner has already applied to themselves.
        // `verdict === 'drafted'`, not `verdict`: a *skipped* post must keep its button. A skip is
        // the model's opinion, and pressing Draft again is how the owner overrules it — the recovery
        // path this file has always been documented as providing and never did, because 'skipped' is
        // as truthy as 'drafted'. The post is out of the batch queue for good by then, so hiding the
        // button was the whole of what buried it.
        // sentTo(): Gmail already holds mail for this recruiter, so the gate could only refuse.
        r.dismissedAt || r.appliedAt || r.verdict === 'drafted' || sentTo(r.stage) || !r.emails.length
          ? null
          : h(UButton, {
              label: 'Draft',
              icon: 'i-lucide-pen-line',
              size: 'xs',
              color: 'neutral',
              variant: 'outline',
              disabled: queued.value.has(r.key),
              // why the model passed on it, so the owner can judge before overruling
              title: r.verdict === 'skipped' && r.verdictReason
                ? `Skipped: ${r.verdictReason}\n\nDraft anyway — you chose it, so the fit screen is relaxed.`
                : undefined,
              onClick: () => draft(r.key)
            }),
        // Every per-row verdict lives behind one trigger, leaving Draft as the only button. Keeping
        // them as separate buttons squeezed the Status column until 'unprocessed' truncated to
        // 'unproce', and this column is already the first thing to go off-screen on a laptop.
        // Ordered by how far each one reaches: this post, this post for good, this source forever.
        h(UDropdownMenu, {
          items: [
            r.dismissedAt
              ? null
              // The way a link-only or phone-only post leaves the queue: nothing here can draft it,
              // so the owner applies through the post itself and records that they did.
              : {
                  label: r.appliedAt ? 'Un-mark applied' : 'Mark applied',
                  icon: r.appliedAt ? 'i-lucide-undo-2' : 'i-lucide-check',
                  disabled: busy.value,
                  onSelect: () => setApplied([r.key], !r.appliedAt)
                },
            r.dismissedAt
              ? null
              : {
                  label: 'Dismiss',
                  icon: 'i-lucide-x',
                  disabled: busy.value,
                  onSelect: () => setDismissed([r.key], true)
                },
            {
              label: 'Exclude…',
              icon: 'i-lucide-ban',
              disabled: busy.value,
              onSelect: () => openExclude(r)
            }
          ].filter(Boolean)
        }, () => h(UButton, {
          'icon': 'i-lucide-ellipsis',
          'color': 'neutral',
          'variant': 'ghost',
          'size': 'sm',
          'title': 'More actions',
          'aria-label': 'More actions'
        })),
        h(UButton, {
          icon: row.getIsExpanded() ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
          color: 'neutral',
          variant: 'ghost',
          size: 'sm',
          onClick: () => row.toggleExpanded()
        })
      ].filter(Boolean))
    }
  },
  {
    accessorKey: 'score',
    header: header('Score', 'score', 'minScore'),
    cell: ({ row }) => h(UBadge, {
      variant: 'subtle',
      color: scoreColor(row.original.score)
    }, () => row.original.score ?? '—')
  },
  {
    accessorKey: 'title',
    header: header('Role', 'title', 'type'),
    // line-clamp, not truncate, and a max width. `truncate` is nowrap, so a table cell grows to the
    // whole line: one 275-char "Multiple roles: ..." title widened this column until Contact..Status sat
    // under the sticky actions, and columns seemed to vanish on whichever page carried such a row.
    // Clamped text can wrap (whitespace-normal: UTable's td is nowrap), so the table can also shrink this
    // column to fit a laptop screen. The budget is tight: this floor (min-w-40) and Contact's max-w-40 hold
    // the grid at 1152px in 1152 at a 1440 viewport, sorted and filtered (header filter buttons take no
    // width — see PostsHeaderCell). 1280 overflows by ~120px, as the pre-grid table did.
    cell: ({ row }) => h('div', { class: 'min-w-40 max-w-md whitespace-normal', title: row.original.title ?? undefined }, [
      h('p', { class: 'font-medium text-highlighted line-clamp-2' }, row.original.title || 'unknown'),
      h('p', { class: 'text-xs text-muted line-clamp-1' }, [
        row.original.company,
        row.original.location
      ].filter(Boolean).join(' · ') || '—')
    ])
  },
  {
    accessorKey: 'emails',
    header: header('Contact', undefined, 'channel'),
    // The route the owner would actually use, best first. A post can carry all three, and `channels` is
    // the scraper's judgement of which are usable — so the marketing link stored beside an address never
    // shows up here, and a link that is shown is one the post invited an application through.
    cell: ({ row }) => {
      const r = row.original
      const has = (c: 'email' | 'link' | 'phone') => r.channels.includes(c)
      // Capped and truncated: a long address used to push the row actions off a laptop screen, and the
      // full value is one row-expand away. The title attribute keeps it readable without that.
      const cls = 'text-xs font-mono block max-w-40 truncate'
      if (has('email')) return h('span', { class: cls, title: r.emails[0] }, r.emails[0])
      if (has('link')) {
        return h('a', {
          'href': r.links[0],
          'target': '_blank',
          'rel': 'noopener noreferrer',
          'class': 'text-xs text-primary hover:underline inline-flex items-center gap-1 max-w-40',
          'title': r.links[0],
          'aria-label': 'Open the application link',
          'onClick': (e: Event) => e.stopPropagation()
        }, [h(UIcon, { name: 'i-lucide-external-link', class: 'size-3 shrink-0' }), 'apply link'])
      }
      if (has('phone')) {
        return h('span', { class: 'text-xs font-mono inline-flex items-center gap-1 max-w-40', title: r.phones[0] }, [
          h(UIcon, { name: 'i-lucide-phone', class: 'size-3 shrink-0 text-muted' }),
          r.phones[0]
        ])
      }
      return h('span', { class: 'text-muted' }, '—')
    }
  },
  {
    id: 'where',
    // scope and country together: both answer "where is this job"
    header: () => h(PostsHeaderCell, {
      label: 'Where',
      sort: view.value.sort,
      dir: view.value.dir,
      active: view.value.scope !== 'all' || view.value.country.length > 0
    }, {
      default: () => [
        h(URadioGroup, {
          'modelValue': view.value.scope,
          'items': OPTIONS.scope,
          'onUpdate:modelValue': (v: PostsView['scope']) => setView({ scope: v })
        }),
        h(USelectMenu, {
          'modelValue': view.value.country,
          'items': countryOptions.value.map(c => ({ label: `${c.name} (${c.count})`, value: c.name })),
          'valueKey': 'value',
          'multiple': true,
          'placeholder': 'Country',
          'class': 'w-56',
          'onUpdate:modelValue': (v: string[]) => setView({ country: v })
        }),
        h(USwitch, {
          'modelValue': view.value.countryMode === 'exclude',
          'label': 'Exclude these countries',
          'disabled': !view.value.country.length,
          'onUpdate:modelValue': (v: boolean) => setView({ countryMode: v ? 'exclude' : 'include' })
        })
      ]
    }),
    cell: ({ row }) => h('div', { class: 'flex gap-1' }, [
      row.original.remote && h(UBadge, { variant: 'soft', color: 'info', size: 'sm' }, () => 'remote'),
      row.original.inScope && h(UBadge, { variant: 'soft', color: 'success', size: 'sm' }, () => 'in scope')
    ].filter(Boolean))
  },
  {
    accessorKey: 'flags',
    header: header('Flags', undefined, 'flags'),
    cell: ({ row }) => {
      const badges = [
        // why a row is excluded: the model's call first, then the regex pre-screen's
        row.original.postType && row.original.postType !== 'hiring'
          ? h(UBadge, { variant: 'subtle', color: 'error', size: 'sm' }, () =>
              row.original.postType === 'seeking' ? 'job seeker' : 'not a job')
          : null,
        ...row.original.flags.map(f =>
          h(UBadge, { variant: 'soft', color: 'warning', size: 'sm' }, () => f))
      ].filter(Boolean)
      return badges.length
        ? h('div', { class: 'flex flex-wrap gap-1' }, badges)
        : h('span', { class: 'text-muted' }, '—')
    }
  },
  {
    // posted_at is derived from LinkedIn's relative age ('2d', '3w') at scrape time, so it is only as
    // precise as that string — the tooltip shows what LinkedIn said. Pasted posts have none.
    id: 'posted',
    header: header('Posted', 'posted', 'posted'),
    cell: ({ row }) => h('span', {
      class: 'text-xs text-muted whitespace-nowrap',
      title: row.original.postedAge ? `LinkedIn said "${row.original.postedAge}" when scraped` : undefined
    }, fmtDate(row.original.postedAt))
  },
  {
    id: 'added',
    header: header('Added', 'added', 'added'),
    cell: ({ row }) => h('span', {
      class: 'text-xs text-muted whitespace-nowrap',
      title: row.original.scrapedAt ? new Date(row.original.scrapedAt).toLocaleString() : undefined
    }, fmtDate(row.original.scrapedAt))
  },
  {
    accessorKey: 'verdict',
    header: header('Status', undefined, 'status'),
    // the owner's own triage outranks the drafter's verdict: a drafted post can be dismissed too.
    // The recruiter's stage outranks the verdict in turn — `drafted` is only where a post starts, and
    // a post whose recruiter was written to about another role has no verdict at all. The verdict's
    // reason stays on hover, since the stage badge hides it.
    cell: ({ row }) => {
      const r = row.original
      return r.dismissedAt
        ? h(UBadge, { variant: 'subtle', color: 'neutral' }, () => STATUS_LABEL.dismissed)
        : r.appliedAt
          ? h(UBadge, { variant: 'subtle', color: 'success' }, () => STATUS_LABEL.applied)
          : r.stage
            ? h(UBadge, {
                variant: 'subtle',
                color: r.stage === 'replied' ? 'success' : r.stage === 'final' ? 'neutral' : 'primary',
                title: r.verdictReason ?? undefined
              }, () => STAGE_LABEL[r.stage!])
            : r.verdict
              ? h(UBadge, {
                  variant: 'subtle',
                  color: r.verdict === 'drafted' ? 'primary' : 'neutral'
                }, () => STATUS_LABEL[r.verdict!])
              : h('span', { class: 'text-xs text-muted' }, STATUS_LABEL.unprocessed)
    }
  }
]
</script>

<template>
  <UDashboardPanel id="posts">
    <template #header>
      <UDashboardNavbar title="Posts">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            :loading="reqStatus === 'pending'"
            @click="refresh()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <StatsStrip />

      <UCard class="shrink-0 mb-4">
        <template #header>
          <span class="font-medium">Paste a post</span>
          <span class="text-xs text-muted ml-2">arrived by email or WhatsApp</span>
        </template>

        <UTextarea
          v-model="pasteText"
          :rows="6"
          placeholder="Paste the whole job post, including however it says to apply."
          class="w-full"
        />

        <template #footer>
          <div class="flex items-center gap-3">
            <UButton
              :disabled="!pasteReady"
              :loading="pasting"
              @click="submitPaste"
            >
              Add post
            </UButton>
            <span class="text-xs text-muted">Scored in the background — you can paste another straight away.</span>
          </div>

          <ul
            v-if="pastes.length"
            class="mt-3 space-y-1"
          >
            <li
              v-for="p in pastes"
              :key="p.at"
              class="flex items-center gap-2 text-sm"
            >
              <UBadge
                :color="pasteBadgeColor(p.state)"
                variant="subtle"
              >
                {{ p.state }}
              </UBadge>
              <span class="truncate">{{ p.detail }}</span>
              <UButton
                v-if="p.state === 'refused' || p.state === 'failed' || p.state === 'unknown'"
                size="xs"
                variant="ghost"
                @click="pasteAgain(p)"
              >
                Paste again
              </UButton>
            </li>
          </ul>
        </template>
      </UCard>

      <div
        ref="filterBar"
        class="flex flex-wrap items-center gap-1.5"
      >
        <UInput
          v-model="qInput"
          class="max-w-sm"
          icon="i-lucide-search"
          placeholder="Search role, company, author, text..."
        />
        <UBadge
          v-for="c in chips"
          :key="c.key"
          color="neutral"
          variant="soft"
          class="gap-1"
        >
          {{ c.label }}
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="link"
            class="p-0"
            :aria-label="`Clear ${c.label}`"
            @click="clearChip(c.key)"
          />
        </UBadge>
        <UButton
          v-if="chips.length"
          label="Reset"
          size="xs"
          color="neutral"
          variant="ghost"
          @click="resetFilters"
        />
        <div class="ml-auto flex items-center gap-1.5">
          <PostsBulkBar
            v-if="selectedKeys.length"
            :count="selectedKeys.length"
            :status="view.status"
            :busy="busy"
            @draft="draftSelected(selectedKeys)"
            @dismiss="setDismissed(selectedKeys, true)"
            @restore="setDismissed(selectedKeys, false)"
            @applied="setApplied(selectedKeys, true)"
            @unapplied="setApplied(selectedKeys, false)"
            @exclude="openBulkExclude"
            @clear="rowSelection = {}"
          />
          <span class="text-sm text-muted">{{ rangeLabel }}</span>
        </div>
      </div>

      <UTable
        v-model:expanded="expanded"
        v-model:row-selection="rowSelection"
        sticky="header"
        :data="data.rows"
        :columns="columns"
        :get-row-id="(row: PostRow) => row.key"
        :loading="reqStatus === 'pending'"
        class="shrink-0"
        :ui="{
          base: 'border-separate border-spacing-0',
          thead: '[&>tr]:bg-elevated/50 [&>tr]:after:content-none',
          tbody: '[&>tr]:last:[&>td]:border-b-0',
          th: 'py-2 first:rounded-l-lg last:rounded-r-lg border-y border-default first:border-l last:border-r',
          td: 'border-b border-default align-top',
          separator: 'h-0'
        }"
      >
        <template #expanded="{ row }">
          <div class="p-4 space-y-3 text-sm whitespace-pre-wrap">
            <p v-if="row.original.postUrl">
              <ULink
                :to="row.original.postUrl"
                target="_blank"
                class="inline-flex items-center gap-1 text-xs"
              >
                View post on LinkedIn
                <UIcon
                  name="i-lucide-external-link"
                  class="size-3 shrink-0"
                />
              </ULink>
            </p>
            <p
              v-if="row.original.refIds.length"
              class="text-muted"
            >
              <span class="font-medium text-highlighted">Reference:</span>
              <span class="font-mono text-xs">{{ row.original.refIds.join(', ') }}</span>
            </p>
            <!-- Every link the card carried, not only the one the Contact column judged usable: when a
                 post looks like it should have been reachable and was not, this is where you look. -->
            <p
              v-if="row.original.links.length || row.original.phones.length"
              class="text-muted flex flex-wrap items-center gap-x-3 gap-y-1"
            >
              <span class="font-medium text-highlighted">Contacts:</span>
              <ULink
                v-for="l in row.original.links"
                :key="l"
                :to="l"
                target="_blank"
                class="inline-flex items-center gap-1 text-xs font-mono"
              >
                {{ l }}
                <UIcon
                  name="i-lucide-external-link"
                  class="size-3 shrink-0"
                />
              </ULink>
              <span
                v-for="ph in row.original.phones"
                :key="ph"
                class="text-xs font-mono"
              >{{ ph }}</span>
            </p>
            <p
              v-if="row.original.reason"
              class="text-muted"
            >
              <span class="font-medium text-highlighted">Model:</span> {{ row.original.reason }}
            </p>
            <pre class="whitespace-pre-wrap font-sans text-xs leading-relaxed max-h-80 overflow-y-auto">{{ row.original.text }}</pre>
          </div>
        </template>
      </UTable>

      <div
        v-if="data.total > PAGE_SIZE"
        class="flex justify-center py-2 shrink-0"
      >
        <UPagination
          v-model:page="page"
          :total="data.total"
          :items-per-page="PAGE_SIZE"
          show-edges
        />
      </div>

      <div
        v-if="!data.rows.length && reqStatus !== 'pending'"
        class="py-16 text-center"
      >
        <UIcon
          name="i-lucide-inbox"
          class="size-8 text-muted mb-2"
        />
        <p class="text-muted">
          No posts match these filters.
        </p>
        <p class="text-xs text-muted mt-1">
          If the database is empty, run a scrape from the <ULink to="/run">Run</ULink> view.
        </p>
      </div>
      <UModal
        v-model:open="excludeOpen"
        title="Never show posts mentioning"
        description="Matched against the whole post — a domain, a company, or a person's name. Whole words only, so &quot;ai&quot; will not match &quot;email&quot;."
      >
        <template #body>
          <template v-if="excludeRow">
            <UInput
              v-model="excludeNeedle"
              placeholder="e.g. example.com"
              autofocus
              class="w-full"
              @keyup.enter="confirmExclude"
            />
            <div
              v-if="excludeSuggestions.length"
              class="mt-3 flex flex-wrap gap-1.5"
            >
              <UButton
                v-for="sug in excludeSuggestions"
                :key="sug"
                :label="sug"
                color="neutral"
                variant="soft"
                size="xs"
                @click="excludeNeedle = sug"
              />
            </div>
          </template>
          <template v-else>
            <UCheckbox
              v-for="n in bulkNeedles"
              :key="n.value"
              v-model="n.on"
              :label="n.value"
              class="py-0.5"
            />
            <p
              v-if="!bulkNeedles.length"
              class="text-sm text-muted"
            >
              The selected rows name no company or recruiter to exclude.
            </p>
            <p class="mt-3 text-xs text-muted">
              Each name matches anywhere in a post's text, as a whole word — a company name also hides posts
              that merely mention it.
            </p>
          </template>
          <p class="mt-3 text-xs text-muted">
            Excluded posts stay in the database and are hidden, not deleted. Remove the rule in Settings to
            bring them back.
          </p>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton
              label="Cancel"
              color="neutral"
              variant="ghost"
              @click="excludeOpen = false"
            />
            <UButton
              label="Exclude"
              color="primary"
              icon="i-lucide-ban"
              :disabled="busy || (excludeRow ? excludeNeedle.trim().length < 2 : !bulkNeedles.some(n => n.on))"
              @click="confirmExclude"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
