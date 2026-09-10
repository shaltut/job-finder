<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { PostRow } from '~/types'

useDashboard()
useHead({ title: 'Posts' })

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

const toast = useToast()
const queued = ref<Set<string>>(new Set())

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
const scope = ref<'all' | 'in-scope' | 'remote'>('all')
const status = ref<'all' | 'unprocessed' | 'drafted' | 'skipped'>('unprocessed')
const minScore = ref(0)

const expanded = ref<Record<string, boolean>>({})

const { data, status: reqStatus, refresh } = await useFetch<{ rows: PostRow[], total: number }>('/api/posts', {
  query: { q, flags, scope, status, minScore },
  lazy: true,
  default: () => ({ rows: [], total: 0 })
})

const columns: TableColumn<PostRow>[] = [
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
    cell: ({ row }) => h('span', { class: 'text-xs font-mono' }, row.original.emails[0] || '—')
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
    cell: ({ row }) => row.original.flags.length
      ? h('div', { class: 'flex flex-wrap gap-1' }, row.original.flags.map(f =>
          h(UBadge, { variant: 'soft', color: 'warning', size: 'sm' }, () => f)))
      : h('span', { class: 'text-muted' }, '—')
  },
  {
    id: 'age',
    header: 'Age',
    cell: ({ row }) => h('span', { class: 'text-xs text-muted' }, age(row.original.postedAge, row.original.postedAt))
  },
  {
    accessorKey: 'verdict',
    header: 'Status',
    cell: ({ row }) => row.original.verdict
      ? h(UBadge, {
          variant: 'subtle',
          color: row.original.verdict === 'drafted' ? 'primary' : 'neutral'
        }, () => row.original.verdict)
      : h('span', { class: 'text-xs text-muted' }, 'unprocessed')
  },
  {
    id: 'actions',
    cell: ({ row }) => h('div', { class: 'flex items-center justify-end gap-1' }, [
      // no second email to a recruiter already handled, and nothing to draft without an address
      row.original.verdict || !row.original.emails.length
        ? null
        : h(UButton, {
            label: 'Draft',
            icon: 'i-lucide-pen-line',
            size: 'xs',
            color: 'neutral',
            variant: 'outline',
            disabled: queued.value.has(row.original.key),
            onClick: () => draft(row.original.key)
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
            { label: 'All', value: 'all' },
            { label: 'Drafted', value: 'drafted' },
            { label: 'Skipped', value: 'skipped' }
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
          v-model="minScore"
          :items="[
            { label: 'Any score', value: 0 },
            { label: '6+', value: 6 },
            { label: '8+', value: 8 }
          ]"
          class="min-w-32"
        />
        <span class="ml-auto text-sm text-muted">{{ data.total }} posts</span>
      </div>

      <UTable
        v-model:expanded="expanded"
        :data="data.rows"
        :columns="columns"
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
