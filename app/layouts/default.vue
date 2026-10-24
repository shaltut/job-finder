<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import type { SyncState } from '~/types'

const open = ref(false)
const colorMode = useColorMode()

function close() {
  open.value = false
}

const { data: unread, refresh: refreshUnread } = await useFetch<{ unread: number }>('/api/inbox/unread', { key: 'inbox-unread', lazy: true, default: () => ({ unread: 0 }) })
let unreadTimer: ReturnType<typeof setInterval> | undefined
// the two-machine lease (server/utils/handoff.ts): on every page, because standby refuses every action
const { data: sync, refresh: refreshSync } = await useFetch<SyncState>('/api/sync', { key: 'sync-state', lazy: true })
const standby = computed(() => sync.value?.enabled && sync.value.role !== 'active' ? sync.value : null)
const standbyText = computed(() => {
  const s = standby.value
  if (!s) return ''
  const other = s.peer?.host ?? 'the other machine'
  if (s.role === 'claiming') return `Taking over from ${other}: waiting for it to stop its jobs and for its last changes to arrive through OneDrive (a minute or two).`
  if (s.role === 'yielding') return `Handing over to ${other}: stopping this machine's jobs.`
  const err = s.lastError ? ` Last problem: ${s.lastError}` : ''
  if (!s.peer) return `This machine is on standby and cannot see the other machine (closed, or OneDrive is not syncing). Press Use this machine to work here.${err}`
  return `${other} is the active machine. This one is on standby: it shows ${other}'s data as it arrives and runs nothing.${err}`
})
async function takeOver() {
  sync.value = await $fetch<SyncState>('/api/sync/claim', { method: 'POST' })
}
let syncTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  unreadTimer = setInterval(refreshUnread, 60_000)
  syncTimer = setInterval(refreshSync, 15_000)
})
onUnmounted(() => {
  clearInterval(unreadTimer)
  clearInterval(syncTimer)
})
useHead({ titleTemplate: t => `${unread.value.unread ? `(${unread.value.unread}) ` : ''}${t ? `${t} · ` : ''}Job Finder` })

const links = computed(() => [[{
  label: 'Posts',
  icon: 'i-lucide-list',
  to: '/',
  onSelect: close
}, {
  label: 'Pipeline',
  icon: 'i-lucide-send',
  to: '/pipeline',
  onSelect: close
}, {
  label: 'Inbox',
  icon: 'i-lucide-inbox',
  to: '/inbox',
  badge: unread.value.unread || undefined,
  onSelect: close
}, {
  label: 'Gaps',
  icon: 'i-lucide-target',
  to: '/gaps',
  onSelect: close
}, {
  label: 'Run',
  icon: 'i-lucide-play',
  to: '/run',
  onSelect: close
}, {
  label: 'Settings',
  icon: 'i-lucide-settings',
  to: '/settings',
  onSelect: close
}]] satisfies NavigationMenuItem[][])

const groups = computed(() => [{
  id: 'links',
  label: 'Go to',
  items: links.value.flat()
}])
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      v-model:open="open"
      collapsible
      resizable
      class="bg-elevated/25"
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <div class="flex items-center gap-2 px-1 py-0.5">
          <UIcon
            name="i-lucide-briefcase-business"
            class="size-5 shrink-0 text-primary"
          />
          <span
            v-if="!collapsed"
            class="truncate font-semibold text-highlighted"
          >Job Finder</span>
        </div>
      </template>

      <template #default="{ collapsed }">
        <UDashboardSearchButton
          :collapsed="collapsed"
          class="bg-transparent ring-default"
        />

        <UNavigationMenu
          :collapsed="collapsed"
          :items="links[0]"
          orientation="vertical"
          tooltip
          popover
        />
      </template>

      <template #footer="{ collapsed }">
        <UButton
          :icon="colorMode.value === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun'"
          :label="collapsed ? undefined : (colorMode.value === 'dark' ? 'Dark' : 'Light')"
          color="neutral"
          variant="ghost"
          block
          :square="collapsed"
          @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'"
        />
      </template>
    </UDashboardSidebar>

    <UDashboardSearch :groups="groups" />

    <slot />

    <UAlert
      v-if="standby"
      class="fixed bottom-4 right-4 z-50 max-w-md shadow-lg"
      color="warning"
      icon="i-lucide-monitor-pause"
      :title="standby.role === 'standby' ? 'Standby' : standby.role === 'claiming' ? 'Taking over' : 'Handing over'"
      :description="standbyText"
      :actions="standby.role === 'standby' ? [{ label: 'Use this machine', color: 'warning', variant: 'solid', onClick: takeOver }] : []"
    />
  </UDashboardGroup>
</template>
