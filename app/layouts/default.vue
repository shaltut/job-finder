<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const open = ref(false)
const colorMode = useColorMode()

function close() {
  open.value = false
}

const links = [[{
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
  label: 'Run',
  icon: 'i-lucide-play',
  to: '/run',
  onSelect: close
}, {
  label: 'Settings',
  icon: 'i-lucide-settings',
  to: '/settings',
  onSelect: close
}]] satisfies NavigationMenuItem[][]

const groups = computed(() => [{
  id: 'links',
  label: 'Go to',
  items: links.flat()
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
  </UDashboardGroup>
</template>
