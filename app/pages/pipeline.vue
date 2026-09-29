<script setup lang="ts">
import { STAGE_LABEL, type Stage } from '#shared/recruiter-stage'
import type { TableColumn } from '@nuxt/ui'
import type { Column } from '@tanstack/vue-table'
import type { Contact, GmailStatus, JobState, StoredDraft } from '~/types'

useDashboard()
useHead({ title: 'Pipeline' })

const toast = useToast()
const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

const { data: drafts, refresh: refreshDrafts } = await useFetch<StoredDraft[]>('/api/drafts', { lazy: true, default: () => [] })
const { data: contacts, refresh: refreshContacts } = await useFetch<Contact[]>('/api/contacts', { lazy: true, default: () => [] })
const { data: gmail, refresh: refreshGmail } = await useFetch<GmailStatus>('/api/gmail/status', {
  lazy: true,
  default: () => ({ configured: false, authorized: false, email: null, expected: null, mismatch: false, redirect: '' })
})
const { data: job, refresh: refreshJob } = await useFetch<JobState>('/api/job', {
  lazy: true,
  default: () => ({
    lanes: { scrape: { current: null, last: null }, draft: { current: null, last: null }, paste: { current: null, last: null } },
    queue: [],
    busy: false
  })
})

// A gaps job runs on this same lane (jobs.ts queues it from runDraftJob's finally), and it is not
// drafting: it emails nobody, and treating it as "drafting" would hide Draft top 10 / Sync with Gmail and
// stall the drafts/contacts refresh below for as long as the gaps job runs (up to hours on a new CV).
const drafting = computed(() => {
  const cur = job.value.lanes.draft.current
  return !!cur && cur.kind !== 'gaps'
})

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (drafting.value) refreshJob()
  }, 2000)
})
onUnmounted(() => clearInterval(timer))

watch(drafting, (now, before) => {
  if (before && !now) {
    refreshDrafts()
    refreshContacts()
    refreshGmail()
  }
})

async function sync() {
  try {
    job.value = await $fetch<JobState>('/api/run/sync', { method: 'POST' })
    toast.add({ title: 'Sync queued', description: 'Re-checks every open recruiter against Gmail.' })
  } catch (e) {
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  }
}

/** When the sweep's note says a follow-up is due, as epoch ms. */
function dueAt(c: Contact): number | null {
  const m = c.note?.match(/follow-up due (.+)$/)
  const t = m ? Date.parse(m[1]!) : NaN
  return Number.isNaN(t) ? null : t
}

/** Follow-up countdown, from the note the sweep wrote. */
function due(c: Contact): string | null {
  const t = dueAt(c)
  if (t === null) return null
  const ms = t - Date.now()
  if (ms <= 0) return 'follow-up due now'
  const h = Math.round(ms / 3600e3)
  return h < 24 ? `follow-up in ${h}h` : `follow-up in ${Math.round(h / 24)}d`
}

const stageColor = (s: string) => (({
  drafted: 'warning',
  contacted: 'info',
  followed_up: 'info',
  replied: 'success',
  final: 'neutral'
} as const)[s] ?? 'neutral')

// Recruiters table. Client-side filter and sort: it is one row per address ever written to, a few
// hundred at most, and /api/contacts already returns all of them.
const STAGES = Object.keys(STAGE_LABEL) as Stage[]
const stageFilter = ref<Stage | null>(null)
const search = ref('')
const sorting = ref([{ id: 'updatedAt', desc: true }])

const stageCounts = computed(() => {
  const n = Object.fromEntries(STAGES.map(s => [s, 0])) as Record<Stage, number>
  for (const c of contacts.value) n[c.stage]++
  return n
})
const shownContacts = computed(() =>
  stageFilter.value ? contacts.value.filter(c => c.stage === stageFilter.value) : contacts.value)

const fmtDate = (v: string | null) => v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'

function sortable(label: string) {
  return ({ column }: { column: Column<Contact> }) => {
    const s = column.getIsSorted()
    return h(UButton, {
      label,
      color: 'neutral',
      variant: 'ghost',
      size: 'xs',
      class: '-mx-2',
      icon: s === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : s === 'desc' ? 'i-lucide-arrow-down-wide-narrow' : 'i-lucide-arrow-up-down',
      onClick: () => column.toggleSorting(s === 'asc')
    })
  }
}

const contactColumns: TableColumn<Contact>[] = [
  {
    id: 'stage',
    // pipeline order, not alphabetical
    accessorFn: c => STAGES.indexOf(c.stage),
    header: sortable('Stage'),
    cell: ({ row }) => h(UBadge, { color: stageColor(row.original.stage), variant: 'subtle' }, () => STAGE_LABEL[row.original.stage])
  },
  {
    accessorKey: 'email',
    header: sortable('Recruiter'),
    cell: ({ row }) => h('span', { class: 'font-mono text-xs text-highlighted block max-w-72 truncate', title: row.original.email }, row.original.email)
  },
  {
    id: 'due',
    // no follow-up due sorts last either way
    accessorFn: c => dueAt(c) ?? undefined,
    sortUndefined: 'last',
    header: sortable('Follow-up'),
    cell: ({ row }) => {
      const d = due(row.original)
      return d ? h(UBadge, { size: 'sm', color: 'info', variant: 'soft' }, () => d) : h('span', { class: 'text-muted' }, '—')
    }
  },
  {
    id: 'lastSentAt',
    accessorFn: c => c.lastSentAt ? Date.parse(c.lastSentAt) : undefined,
    sortUndefined: 'last',
    header: sortable('Last sent'),
    cell: ({ row }) => h('span', { class: 'text-xs text-muted whitespace-nowrap' }, fmtDate(row.original.lastSentAt))
  },
  {
    id: 'updatedAt',
    accessorFn: c => Date.parse(c.updatedAt),
    header: sortable('Updated'),
    cell: ({ row }) => h('span', { class: 'text-xs text-muted whitespace-nowrap' }, fmtDate(row.original.updatedAt))
  },
  {
    accessorKey: 'note',
    header: 'Note',
    enableSorting: false,
    cell: ({ row }) => h('span', { class: 'text-xs text-muted block max-w-md truncate', title: row.original.note ?? undefined }, row.original.note ?? '')
  }
]

async function draftTop() {
  try {
    job.value = await $fetch<JobState>('/api/run/draft', { method: 'POST', body: { n: 10 } })
    toast.add({ title: 'Drafting queued', description: 'Roughly 30 seconds per recruiter.' })
  } catch (e) {
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  }
}

function copy(d: StoredDraft) {
  const text = [d.subject ? `Subject: ${d.subject}` : '', '', d.body, '', d.signature].filter(Boolean).join('\n')
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', description: `Email to ${d.recruiterEmail}`, icon: 'i-lucide-check' })
}
</script>

<template>
  <UDashboardPanel id="pipeline">
    <template #header>
      <UDashboardNavbar title="Pipeline">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            v-if="drafting"
            label="Stop drafting"
            color="error"
            variant="subtle"
            icon="i-lucide-square"
            @click="$fetch('/api/job/stop', { method: 'POST', body: { lane: 'draft' } }).then(() => refreshJob())"
          />
          <UButton
            v-if="!drafting && gmail.authorized"
            label="Sync with Gmail"
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            @click="sync"
          />
          <UButton
            v-if="!drafting"
            label="Draft top 10"
            icon="i-lucide-pen-line"
            @click="draftTop"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        icon="i-lucide-info"
        color="neutral"
        variant="subtle"
        title="Nothing here is sent"
        :description="gmail.authorized
          ? `Drafts are created in Gmail with the CV attached, addressed and waiting. You attach nothing and press send yourself. Connected as ${gmail.email}.`
          : 'Gmail is not connected, so drafts are written to data/drafts/ for you to copy. Connect it in Settings to have them created in Gmail with the CV attached.'"
        class="shrink-0"
      />

      <UCard
        v-if="drafting"
        class="shrink-0"
      >
        <template #header>
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-highlighted">
              Drafting
            </h2>
            <UBadge
              color="primary"
              variant="subtle"
            >
              running
            </UBadge>
          </div>
        </template>
        <div class="max-h-64 overflow-y-auto rounded-md bg-elevated/50 p-3 font-mono text-xs whitespace-pre-wrap">
          {{ job.lanes.draft.current?.log.join('\n') }}
        </div>
      </UCard>

      <UCard class="shrink-0">
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Recruiters ({{ contacts.length }})
          </h2>
          <p class="text-sm text-muted">
            Two emails per address, ever: the application and one follow-up. <code class="text-xs">final</code> is never reset.
          </p>
        </template>
        <div
          v-if="contacts.length"
          class="space-y-3"
        >
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              :label="`All ${contacts.length}`"
              size="xs"
              color="neutral"
              :variant="stageFilter ? 'outline' : 'solid'"
              @click="stageFilter = null"
            />
            <UButton
              v-for="s in STAGES"
              :key="s"
              :label="`${STAGE_LABEL[s]} ${stageCounts[s]}`"
              size="xs"
              :color="stageColor(s)"
              :variant="stageFilter === s ? 'solid' : 'subtle'"
              :disabled="!stageCounts[s]"
              @click="stageFilter = stageFilter === s ? null : s"
            />
            <UInput
              v-model="search"
              icon="i-lucide-search"
              placeholder="Search address or note"
              size="sm"
              class="ml-auto w-64"
            />
          </div>
          <UTable
            v-model:sorting="sorting"
            v-model:global-filter="search"
            :data="shownContacts"
            :columns="contactColumns"
            sticky
            class="max-h-[32rem]"
          />
        </div>
        <p
          v-else
          class="py-6 text-center text-sm text-muted"
        >
          No recruiter has been drafted to yet.
        </p>
      </UCard>

      <UCard
        v-for="d in drafts"
        :key="d.recruiterEmail + d.mode"
        class="shrink-0"
      >
        <template #header>
          <div class="flex flex-wrap items-center gap-2">
            <UBadge
              :color="d.mode === 'follow-up' ? 'info' : 'primary'"
              variant="subtle"
            >
              {{ d.mode }}
            </UBadge>
            <span class="font-mono text-xs text-highlighted">{{ d.recruiterEmail }}</span>
            <span class="text-xs text-muted">{{ new Date(d.createdAt).toLocaleString() }}</span>
            <UButton
              label="Copy"
              icon="i-lucide-copy"
              size="xs"
              color="neutral"
              variant="outline"
              class="ml-auto"
              @click="copy(d)"
            />
          </div>
          <p
            v-if="d.subject"
            class="mt-2 font-medium text-highlighted"
          >
            {{ d.subject }}
          </p>
          <div
            v-if="d.gaps.length"
            class="mt-2 flex flex-wrap gap-1"
          >
            <UBadge
              v-for="g in d.gaps"
              :key="g"
              size="sm"
              color="warning"
              variant="soft"
            >
              {{ g }}
            </UBadge>
          </div>
        </template>

        <pre class="whitespace-pre-wrap font-sans text-sm leading-relaxed">{{ d.body }}</pre>
        <template #footer>
          <pre class="whitespace-pre-wrap font-sans text-xs text-muted">{{ d.signature }}</pre>
        </template>
      </UCard>

      <div
        v-if="!drafts.length && !drafting"
        class="py-12 text-center"
      >
        <UIcon
          name="i-lucide-mail-plus"
          class="size-8 text-muted mb-2"
        />
        <p class="text-muted">
          No drafts yet.
        </p>
        <p class="text-xs text-muted mt-1">
          Press <strong>Draft top 10</strong>, or use the Draft button on a single post.
        </p>
      </div>
    </template>
  </UDashboardPanel>
</template>
