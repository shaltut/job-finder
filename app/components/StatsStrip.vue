<script setup lang="ts">
import type { Stats } from '~/types'

const empty: Stats = { total: 0, usable: 0, unprocessed: 0, last24h: 0, drafted: 0, lastScrapeAt: null }
// Named, so a page that changes the numbers — dismissing a post from the Posts view — can refresh them
// with refreshNuxtData('stats') without this component having to expose anything.
const { data } = await useFetch<Stats>('/api/stats', { key: 'stats', lazy: true, default: () => empty })

const lastScrape = computed(() => {
  const at = data.value.lastScrapeAt
  if (!at) return 'never'
  const hours = Math.round((Date.now() - Date.parse(at)) / 3600e3)
  if (hours < 1) return 'just now'
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
})

const stats = computed(() => [
  { title: 'Usable', icon: 'i-lucide-target', value: data.value.usable, hint: 'score 6+, unflagged, in scope' },
  { title: 'To review', icon: 'i-lucide-inbox', value: data.value.unprocessed, hint: 'unflagged, no verdict yet' },
  { title: 'Drafted', icon: 'i-lucide-mail', value: data.value.drafted, hint: 'applications written' },
  { title: 'Last 24h', icon: 'i-lucide-clock', value: data.value.last24h, hint: `last scrape ${lastScrape.value}` }
])
</script>

<template>
  <UPageGrid class="lg:grid-cols-4 gap-4 sm:gap-6 lg:gap-px">
    <UPageCard
      v-for="stat in stats"
      :key="stat.title"
      :icon="stat.icon"
      :title="stat.title"
      variant="subtle"
      :ui="{
        container: 'gap-y-1.5',
        wrapper: 'items-start',
        leading: 'p-2.5 rounded-full bg-primary/10 ring ring-inset ring-primary/25 flex-col',
        title: 'font-normal text-muted text-xs uppercase'
      }"
      class="lg:rounded-none first:rounded-l-lg last:rounded-r-lg"
    >
      <div class="flex flex-col gap-0.5">
        <span class="text-2xl font-semibold text-highlighted">{{ stat.value }}</span>
        <span class="text-xs text-muted">{{ stat.hint }}</span>
      </div>
    </UPageCard>
  </UPageGrid>
</template>
