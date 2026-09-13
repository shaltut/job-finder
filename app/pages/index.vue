<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { PostRow } from '~/types'

useDashboard()
useHead({ title: 'Posts' })

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')
const UCheckbox = resolveComponent('UCheckbox')
const UIcon = resolveComponent('UIcon')

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
  } catch (e) {
    queued.value = new Set([...queued.value].filter(k => k !== key))
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  }
}

const q = ref('')
const flags = ref<'all' | 'clean' | 'flagged'>('clean')
const type = ref<'hiring' | 'all' | 'other'>('hiring')
const scope = ref<'all' | 'in-scope' | 'remote'>('all')
const status = ref<'all' | 'unprocessed' | 'drafted' | 'skipped' | 'dismissed' | 'applied'>('unprocessed')
const channel = ref<'all' | 'email' | 'link' | 'phone'>('all')
const minScore = ref(0)

// Seekers carry the `seeking-work` flag, so asking for non-hiring posts under the default 'Unflagged'
// would return only the unflagged non-jobs and hide the very rows this filter exists to show.
watch(type, (t) => {
  if (t === 'other') flags.value = 'all'
})

const expanded = ref<Record<string, boolean>>({})
const rowSelection = ref<Record<string, boolean>>({})

const { data, status: reqStatus, refresh } = await useFetch<{ rows: PostRow[], total: number }>('/api/posts', {
  query: { q, flags, scope, status, channel, minScore, type },
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

watch([q, flags, type, scope, status, channel, minScore], () => {
  rowSelection.value = {}
})

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

const columns: TableColumn<PostRow>[] = [
  {
    id: 'select',
    header: ({ table }) => h(UCheckbox, {
      'modelValue': table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected(),
      'onUpdate:modelValue': (v: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(!!v),
      'aria-label': 'Select all'
    }),
    cell: ({ row }) => h(UCheckbox, {
      'modelValue': row.getIsSelected(),
      'onUpdate:modelValue': (v: boolean | 'indeterminate') => row.toggleSelected(!!v),
      'aria-label': 'Select row'
    })
  },
  {
    accessorKey: 'score',
    header: 'Score',
    cell: ({ row }) => h(UBadge, {
      variant: 'subtle',
      color: scoreColor(row.original.score)
    }, () => row.original.score ?? '—')
  },
  {
    accessorKey: 'title',
    header: 'Role',
    cell: ({ row }) => h('div', { class: 'min-w-0' }, [
      h('p', { class: 'font-medium text-highlighted truncate' }, row.original.title || 'unknown'),
      h('p', { class: 'text-xs text-muted truncate' }, [
        row.original.company,
        row.original.location
      ].filter(Boolean).join(' · ') || '—')
    ])
  },
  {
    accessorKey: 'emails',
    header: 'Contact',
    // The route the owner would actually use, best first. A post can carry all three, and `channels` is
    // the scraper's judgement of which are usable — so the marketing link stored beside an address never
    // shows up here, and a link that is shown is one the post invited an application through.
    cell: ({ row }) => {
      const r = row.original
      const has = (c: 'email' | 'link' | 'phone') => r.channels.includes(c)
      if (has('email')) return h('span', { class: 'text-xs font-mono' }, r.emails[0])
      if (has('link')) {
        return h('a', {
          'href': r.links[0],
          'target': '_blank',
          'rel': 'noopener noreferrer',
          'class': 'text-xs text-primary hover:underline inline-flex items-center gap-1',
          'title': r.links[0],
          'aria-label': 'Open the application link',
          'onClick': (e: Event) => e.stopPropagation()
        }, [h(UIcon, { name: 'i-lucide-external-link', class: 'size-3 shrink-0' }), 'apply link'])
      }
      if (has('phone')) {
        return h('span', { class: 'text-xs font-mono inline-flex items-center gap-1' }, [
          h(UIcon, { name: 'i-lucide-phone', class: 'size-3 shrink-0 text-muted' }),
          r.phones[0]
        ])
      }
      return h('span', { class: 'text-muted' }, '—')
    }
  },
  {
    id: 'where',
    header: 'Where',
    cell: ({ row }) => h('div', { class: 'flex gap-1' }, [
      row.original.remote && h(UBadge, { variant: 'soft', color: 'info', size: 'sm' }, () => 'remote'),
      row.original.inScope && h(UBadge, { variant: 'soft', color: 'success', size: 'sm' }, () => 'in scope')
    ].filter(Boolean))
  },
  {
    accessorKey: 'flags',
    header: 'Flags',
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
    id: 'age',
    header: 'Age',
    cell: ({ row }) => h('span', { class: 'text-xs text-muted' }, age(row.original.postedAge, row.original.postedAt))
  },
  {
    accessorKey: 'verdict',
    header: 'Status',
    // the owner's own triage outranks the drafter's verdict: a drafted post can be dismissed too
    cell: ({ row }) => row.original.dismissedAt
      ? h(UBadge, { variant: 'subtle', color: 'neutral' }, () => 'dismissed')
      : row.original.appliedAt
        ? h(UBadge, { variant: 'subtle', color: 'success' }, () => 'applied')
        : row.original.verdict
          ? h(UBadge, {
              variant: 'subtle',
              color: row.original.verdict === 'drafted' ? 'primary' : 'neutral'
            }, () => row.original.verdict)
          : h('span', { class: 'text-xs text-muted' }, 'unprocessed')
  },
  {
    id: 'actions',
    cell: ({ row }) => {
      const r = row.original
      return h('div', { class: 'flex items-center justify-end gap-1' }, [
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
        // nothing to draft for a role the owner has already applied to themselves
        r.dismissedAt || r.appliedAt || r.verdict || !r.emails.length
          ? null
          : h(UButton, {
              label: 'Draft',
              icon: 'i-lucide-pen-line',
              size: 'xs',
              color: 'neutral',
              variant: 'outline',
              disabled: queued.value.has(r.key),
              onClick: () => draft(r.key)
            }),
        // The way a link-only or phone-only post leaves the queue: nothing here can draft it, so the
        // owner applies through the post itself and records that they did.
        r.dismissedAt
          ? null
          : h(UButton, {
              'icon': r.appliedAt ? 'i-lucide-undo-2' : 'i-lucide-check',
              'color': r.appliedAt ? 'neutral' : 'success',
              'variant': 'ghost',
              'size': 'sm',
              'title': r.appliedAt ? 'Applied — click to un-mark' : 'Mark applied',
              'aria-label': r.appliedAt ? 'Un-mark applied' : 'Mark applied',
              'disabled': busy.value,
              'onClick': () => setApplied([r.key], !r.appliedAt)
            }),
        r.dismissedAt
          ? null
          : h(UButton, {
              'icon': 'i-lucide-x',
              'color': 'neutral',
              'variant': 'ghost',
              'size': 'sm',
              'title': 'Dismiss',
              'aria-label': 'Dismiss',
              'disabled': busy.value,
              'onClick': () => setDismissed([r.key], true)
            }),
        h(UButton, {
          icon: row.getIsExpanded() ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
          color: 'neutral',
          variant: 'ghost',
          size: 'sm',
          onClick: () => row.toggleExpanded()
        })
      ].filter(Boolean))
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

      <div class="flex flex-wrap items-center gap-1.5">
        <UInput
          v-model="q"
          class="max-w-sm"
          icon="i-lucide-search"
          placeholder="Search role, company, author, text..."
        />
        <USelect
          v-model="status"
          :items="[
            { label: 'Unprocessed', value: 'unprocessed' },
            { label: 'All active', value: 'all' },
            { label: 'Drafted', value: 'drafted' },
            { label: 'Skipped', value: 'skipped' },
            { label: 'Applied by hand', value: 'applied' },
            { label: 'Dismissed', value: 'dismissed' }
          ]"
          class="min-w-36"
        />
        <USelect
          v-model="type"
          :items="[
            { label: 'Hiring only', value: 'hiring' },
            { label: 'Any post type', value: 'all' },
            { label: 'Not hiring', value: 'other' }
          ]"
          class="min-w-36"
        />
        <USelect
          v-model="flags"
          :items="[
            { label: 'Unflagged', value: 'clean' },
            { label: 'Any flags', value: 'all' },
            { label: 'Flagged only', value: 'flagged' }
          ]"
          class="min-w-36"
        />
        <USelect
          v-model="scope"
          :items="[
            { label: 'Anywhere', value: 'all' },
            { label: 'In scope', value: 'in-scope' },
            { label: 'Remote', value: 'remote' }
          ]"
          class="min-w-32"
        />
        <USelect
          v-model="channel"
          :items="[
            { label: 'Any contact', value: 'all' },
            { label: 'By email', value: 'email' },
            { label: 'By link', value: 'link' },
            { label: 'By phone', value: 'phone' }
          ]"
          class="min-w-32"
        />
        <USelect
          v-model="minScore"
          :items="[
            { label: 'Any score', value: 0 },
            { label: '6+', value: 6 },
            { label: '8+', value: 8 }
          ]"
          class="min-w-32"
        />
        <div class="ml-auto flex items-center gap-1.5">
          <template v-if="selectedKeys.length">
            <span class="text-sm text-muted">{{ selectedKeys.length }} selected</span>
            <UButton
              v-if="status === 'dismissed'"
              label="Restore"
              icon="i-lucide-undo-2"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="busy"
              @click="setDismissed(selectedKeys, false)"
            />
            <UButton
              v-else-if="status === 'applied'"
              label="Un-mark"
              icon="i-lucide-undo-2"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="busy"
              @click="setApplied(selectedKeys, false)"
            />
            <UButton
              v-else
              label="Applied"
              icon="i-lucide-check"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="busy"
              @click="setApplied(selectedKeys, true)"
            />
            <UButton
              v-if="status !== 'dismissed' && status !== 'applied'"
              label="Dismiss"
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="outline"
              :loading="busy"
              @click="setDismissed(selectedKeys, true)"
            />
          </template>
          <span class="text-sm text-muted">{{ data.total }} posts</span>
        </div>
      </div>

      <UTable
        v-model:expanded="expanded"
        v-model:row-selection="rowSelection"
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
    </template>
  </UDashboardPanel>
</template>
