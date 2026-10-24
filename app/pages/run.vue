<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { JobState, SyncState, YieldRow } from '~/types'

useDashboard()
useHead({ title: 'Run' })

const toast = useToast()
const config = await $fetch<{ terms: string[], max: number, since: string }>('/api/config')

const terms = ref('')
const max = ref<number>(config.max)
const since = ref<string>(config.since)

const { data: job, refresh: refreshJob } = await useFetch<JobState>('/api/job', {
  lazy: true,
  default: () => ({
    lanes: { scrape: { current: null, last: null }, draft: { current: null, last: null }, paste: { current: null, last: null }, gaps: { current: null, last: null }, send: { current: null, last: null } },
    queue: [],
    busy: false
  })
})
const { data: yields, refresh: refreshYield } = await useFetch<YieldRow[]>('/api/yield', { lazy: true, default: () => [] })

// Poll while anything is running, then stop. Cheap, and it keeps the log honest without SSE plumbing.
const running = computed(() => job.value.busy || job.value.queue.length > 0)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (running.value) refreshJob()
  }, 1500)
})
onUnmounted(() => clearInterval(timer))

// when the scrape lane goes idle, the numbers behind it have changed
watch(() => job.value.lanes.scrape.current, (now, before) => {
  if (before && !now) {
    refreshYield()
    refreshJob()
  }
})

const { data: syncState, refresh: refreshSync } = await useFetch<SyncState>('/api/sync', { lazy: true })
watch(running, (r) => {
  if (!r) refreshSync()
})
async function syncNow() {
  try {
    // an empty folder is seeded only from this button, never by the timer
    syncState.value = await $fetch<SyncState>('/api/sync/push', { method: 'POST', body: { init: syncState.value?.remoteGen === null } })
    const s = syncState.value
    toast.add({
      title: s.conflict ? 'Not pushed — another machine pushed first' : s.lastError || s.pushDisabled ? 'Not pushed' : `Synced (gen ${s.gen})`,
      color: s.conflict || s.lastError || s.pushDisabled ? 'error' : 'success'
    })
  } catch (e) {
    toast.add({ title: 'Sync failed', description: (e as Error).message, color: 'error' })
  }
}

async function post(url: string, body?: Record<string, unknown>) {
  try {
    job.value = await $fetch<JobState>(url, { method: 'POST', body })
  } catch (e) {
    toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })
  }
}

const startScrape = () => post('/api/run/scrape', {
  ...(terms.value.trim() ? { terms: terms.value.trim() } : {}),
  max: max.value,
  since: since.value
})

const active = computed(() => job.value.lanes.scrape.current ?? job.value.lanes.draft.current ?? job.value.lanes.gaps.current ?? job.value.lanes.send.current)
const shown = computed(() => active.value ?? job.value.lanes.scrape.last ?? job.value.lanes.draft.last ?? job.value.lanes.gaps.last ?? job.value.lanes.send.last)

const { data: sendCounts, refresh: refreshSend } = await useFetch<{ pending: number, sent: number, held: number }>('/api/send/pending', {
  lazy: true, default: () => ({ pending: 0, sent: 0, held: 0 })
})
watch(() => job.value.lanes.send.current?.log.length, () => refreshSend())
async function startSending() {
  await post('/api/run/send')
  await refreshSend()
}

const logBox = useTemplateRef<HTMLElement>('logBox')
watch(() => shown.value?.log.length, async () => {
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
})

const yieldColumns: TableColumn<YieldRow>[] = [
  { accessorKey: 'term', header: 'Search term' },
  { accessorKey: 'posts', header: 'Posts' },
  { accessorKey: 'usable', header: 'Usable' },
  { accessorKey: 'drafted', header: 'Drafted' }
]
</script>

<template>
  <UDashboardPanel id="run">
    <template #header>
      <UDashboardNavbar title="Run">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            v-if="job.lanes.scrape.current"
            label="Stop scrape"
            color="error"
            variant="subtle"
            icon="i-lucide-square"
            @click="post('/api/job/stop', { lane: 'scrape' })"
          />
          <UButton
            v-if="job.lanes.gaps.current"
            label="Stop gaps"
            color="error"
            variant="subtle"
            icon="i-lucide-square"
            @click="post('/api/job/stop', { lane: 'gaps' })"
          />
          <UButton
            v-if="job.lanes.send.current"
            label="Stop sending"
            color="error"
            variant="subtle"
            icon="i-lucide-square"
            @click="post('/api/job/stop', { lane: 'send' })"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UCard class="shrink-0">
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Scrape
          </h2>
          <p class="text-sm text-muted">
            Leave the terms box empty to run all {{ config.terms.length }} configured runs, including your home feed.
          </p>
        </template>

        <div class="flex flex-wrap items-end gap-3">
          <UFormField
            label="Terms (comma separated)"
            class="grow min-w-64"
          >
            <UInput
              v-model="terms"
              :placeholder="[...new Set(config.terms)].join(', ')"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Max cards / term">
            <UInput
              v-model.number="max"
              type="number"
              :min="1"
              :max="200"
              class="w-32"
            />
          </UFormField>
          <UFormField label="Posted">
            <USelect
              v-model="since"
              :items="[
                { label: 'Past 24 hours', value: 'past-24h' },
                { label: 'Past week', value: 'past-week' },
                { label: 'Past month', value: 'past-month' }
              ]"
              class="w-40"
            />
          </UFormField>
          <UButton
            label="Start scrape"
            icon="i-lucide-play"
            :disabled="!!job.lanes.scrape.current"
            @click="startScrape"
          />
        </div>

        <template #footer>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm text-muted mr-auto">Maintenance</span>
            <UButton
              label="Recompute flags"
              icon="i-lucide-flag"
              color="neutral"
              variant="outline"
              size="sm"
              title="Re-run the regex pre-screen over stored posts. No API calls."
              :disabled="!!job.lanes.scrape.current"
              @click="post('/api/run/reflag')"
            />
            <UButton
              label="Re-extract contacts"
              icon="i-lucide-link"
              color="neutral"
              variant="outline"
              size="sm"
              title="Re-read links, numbers and reference ids from stored posts. No API calls."
              :disabled="!!job.lanes.scrape.current"
              @click="post('/api/run/reextract')"
            />
            <UButton
              label="Rescore all"
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="outline"
              size="sm"
              title="Rescore every stored post against the current CV and prompt. Costs OpenAI calls."
              :disabled="!!job.lanes.scrape.current"
              @click="post('/api/run/rescore')"
            />
            <UButton
              label="Extract gaps"
              icon="i-lucide-list-checks"
              color="neutral"
              variant="outline"
              size="sm"
              title="Read every application not yet read against the current CV, for the Gaps page. Costs OpenAI calls."
              @click="post('/api/run/gaps')"
            />
          </div>
        </template>
      </UCard>

      <UCard
        v-if="job.queue.length"
        class="shrink-0"
      >
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Queued ({{ job.queue.length }})
          </h2>
        </template>
        <div class="space-y-2">
          <div
            v-for="q in job.queue"
            :key="q.id"
            class="flex items-center gap-2 text-sm"
          >
            <UBadge
              variant="subtle"
              color="neutral"
            >
              {{ q.lane }}
            </UBadge>
            <span class="text-highlighted">{{ q.kind }}</span>
            <span class="text-muted">queued {{ new Date(q.queuedAt).toLocaleTimeString() }}</span>
            <UButton
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="ghost"
              class="ml-auto"
              @click="post(`/api/queue/${q.id}/cancel`)"
            />
          </div>
        </div>
      </UCard>

      <UCard
        v-if="shown"
        class="shrink-0"
      >
        <template #header>
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-highlighted">
              {{ shown.kind }}
            </h2>
            <UBadge
              v-if="shown.running"
              color="primary"
              variant="subtle"
            >
              running
            </UBadge>
            <UBadge
              v-else
              :color="shown.exit === 0 ? 'success' : 'error'"
              variant="subtle"
            >
              exit {{ shown.exit }}
            </UBadge>
            <span class="text-sm text-muted">{{ shown.added }} row(s) written</span>
          </div>
        </template>
        <div
          ref="logBox"
          class="max-h-96 overflow-y-auto rounded-md bg-elevated/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
        >
          {{ shown.log.join('\n') || 'waiting for output…' }}
        </div>
      </UCard>

      <UCard class="shrink-0">
        <div class="flex items-center gap-3 text-sm">
          <span class="font-semibold text-highlighted">Send drafts</span>
          <span class="text-muted mr-auto">
            {{ sendCounts.pending }} pending · {{ sendCounts.sent }} sent by the lane{{ sendCounts.held ? ` · ${sendCounts.held} held back` : '' }}
            — 10 at random every 15 minutes, each re-checked against Gmail first
          </span>
          <UButton
            size="sm"
            color="primary"
            icon="i-lucide-send"
            :loading="!!job.lanes.send.current"
            :disabled="!!job.lanes.send.current || (!sendCounts.pending && !sendCounts.held)"
            @click="startSending"
          >
            {{ job.lanes.send.current ? 'Sending…' : 'Send drafts' }}
          </UButton>
        </div>
      </UCard>

      <UCard
        v-if="syncState?.enabled"
        class="shrink-0"
      >
        <div class="flex items-center gap-3 text-sm">
          <span class="font-semibold text-highlighted">Sync</span>
          <span class="text-muted mr-auto">
            {{ syncState.host }} · gen {{ syncState.gen }} · last push {{ syncState.lastPushAt ? new Date(syncState.lastPushAt).toLocaleTimeString() : 'not yet this session' }}
          </span>
          <UButton
            size="sm"
            variant="soft"
            icon="i-lucide-refresh-cw"
            :disabled="!!syncState.conflict || !!syncState.pushDisabled"
            @click="syncNow"
          >
            {{ syncState.remoteGen === null ? 'Start syncing from this machine' : 'Sync now' }}
          </UButton>
        </div>
        <UAlert
          v-if="syncState.conflict"
          class="mt-3"
          color="error"
          :title="`${syncState.conflict.host} pushed gen ${syncState.conflict.gen} after this machine started. Restart to pull it — work done here since is in backups/conflict-*.db.`"
        />
        <UAlert
          v-else-if="syncState.pushDisabled"
          class="mt-3"
          color="warning"
          :title="syncState.pushDisabled"
        />
        <UAlert
          v-else-if="syncState.otherActive"
          class="mt-3"
          color="warning"
          title="The other machine looks active. Close it before working here."
        />
        <p
          v-if="syncState.lastError"
          class="mt-2 text-xs text-error"
        >
          {{ syncState.lastError }}
        </p>
      </UCard>

      <UCard class="shrink-0">
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Yield by search term
          </h2>
          <p class="text-sm text-muted">
            Usable = score 6+, no flags, remote or in scope. Drop the terms that never produce one.
          </p>
        </template>
        <UTable
          v-if="yields.length"
          :data="yields"
          :columns="yieldColumns"
        />
        <p
          v-else
          class="py-6 text-center text-sm text-muted"
        >
          No posts stored yet — run a scrape above.
        </p>
      </UCard>
    </template>
  </UDashboardPanel>
</template>
