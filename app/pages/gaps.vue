<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { keywordList, type GapGroup, type GapsResponse, type GapTerm } from '#shared/gaps'

useDashboard()
useHead({ title: 'Gaps' })

const toast = useToast()
const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')

const { data, status } = await useFetch<GapsResponse>('/api/gaps', {
  lazy: true,
  default: () => ({ terms: [], applications: 0, analysed: 0 })
})

const show = ref<'gaps' | GapGroup | 'all'>('gaps')
const category = ref('all')
const expanded = ref<Record<string, boolean>>({})

const categories = computed(() => ['all', ...new Set(data.value.terms.map(t => t.category))])

const rows = computed(() => data.value.terms.filter(t =>
  (show.value === 'all' || (show.value === 'gaps' ? t.group !== 'on-cv' : t.group === show.value))
  && (category.value === 'all' || t.category === category.value)))

const GROUP: Record<GapGroup, { label: string, color: 'error' | 'warning' | 'success' }> = {
  'learn': { label: 'Learn', color: 'error' },
  'add': { label: 'Add now', color: 'warning' },
  'on-cv': { label: 'On your CV', color: 'success' }
}

const columns: TableColumn<GapTerm>[] = [
  {
    id: 'expand',
    cell: ({ row }) => h(UButton, {
      icon: row.getIsExpanded() ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
      color: 'neutral',
      variant: 'ghost',
      size: 'xs',
      onClick: () => row.toggleExpanded()
    })
  },
  {
    accessorKey: 'term',
    header: 'Keyword',
    cell: ({ row }) => h('span', { class: 'font-medium text-highlighted' }, row.original.term)
  },
  {
    accessorKey: 'category',
    header: 'Category',
    cell: ({ row }) => h('span', { class: 'text-muted' }, row.original.category)
  },
  {
    id: 'asked',
    header: 'Asked by',
    cell: ({ row }) => {
      const t = row.original
      return `${t.applications} application${t.applications === 1 ? '' : 's'} · ${t.must} must-have`
    }
  },
  {
    accessorKey: 'group',
    header: 'Group',
    cell: ({ row }) => h(UBadge, { variant: 'subtle', color: GROUP[row.original.group].color }, () => GROUP[row.original.group].label)
  },
  {
    accessorKey: 'lastSeen',
    header: 'Last seen',
    cell: ({ row }) => h('span', { class: 'text-xs text-muted' }, row.original.lastSeen?.slice(0, 10) ?? '—')
  }
]

async function copyList() {
  try {
    await navigator.clipboard.writeText(keywordList(data.value.terms))
    toast.add({ title: 'Keyword list copied', icon: 'i-lucide-clipboard-check' })
  } catch (e) {
    toast.add({ title: 'Could not copy', description: String(e), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel id="gaps">
    <template #header>
      <UDashboardNavbar title="Gaps">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            label="Copy keyword list"
            icon="i-lucide-clipboard"
            color="neutral"
            variant="outline"
            :disabled="!data.terms.some(t => t.group !== 'on-cv')"
            @click="copyList"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="text-sm text-muted shrink-0">
        {{ data.analysed }} of {{ data.applications }} applications analysed against your current CV.
        <template v-if="data.analysed < data.applications">
          Press <ULink to="/run">Extract gaps</ULink> in the Run view to read the rest.
        </template>
      </p>

      <div class="flex flex-wrap items-center gap-1.5 shrink-0">
        <USelect
          v-model="show"
          :items="[
            { label: 'Add now + Learn', value: 'gaps' },
            { label: 'Add now', value: 'add' },
            { label: 'Learn', value: 'learn' },
            { label: 'On your CV', value: 'on-cv' },
            { label: 'All', value: 'all' }
          ]"
          class="w-44"
        />
        <USelect
          v-model="category"
          :items="categories.map(c => ({ label: c === 'all' ? 'Any category' : c, value: c }))"
          class="w-44"
        />
        <span class="text-sm text-muted ml-auto">{{ rows.length }} keywords</span>
      </div>

      <UTable
        v-model:expanded="expanded"
        :data="rows"
        :columns="columns"
        :get-row-id="(t: GapTerm) => t.term.toLowerCase()"
        :loading="status === 'pending'"
        class="shrink-0"
      >
        <template #expanded="{ row }">
          <ul class="p-4 space-y-3 text-sm">
            <li
              v-for="p in row.original.posts"
              :key="p.key"
              class="space-y-1"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-highlighted">{{ p.title || 'Untitled role' }}</span>
                <span
                  v-if="p.company"
                  class="text-muted"
                >@ {{ p.company }}</span>
                <UBadge
                  variant="subtle"
                  color="neutral"
                  size="sm"
                >
                  {{ p.importance === 'must' ? 'must-have' : 'nice-to-have' }}
                </UBadge>
                <UBadge
                  variant="subtle"
                  color="neutral"
                  size="sm"
                >
                  {{ p.status }}
                </UBadge>
                <ULink
                  v-if="p.postUrl"
                  :to="p.postUrl"
                  target="_blank"
                  class="text-xs"
                >
                  View post
                </ULink>
              </div>
              <p class="text-muted italic">
                “{{ p.quote }}”
              </p>
              <p
                v-if="p.cvShows"
                class="text-xs text-muted"
              >
                Your CV: {{ p.cvShows }}
              </p>
            </li>
          </ul>
        </template>
      </UTable>

      <div
        v-if="!rows.length && status !== 'pending'"
        class="py-16 text-center text-muted"
      >
        No keywords here yet.
      </div>
    </template>
  </UDashboardPanel>
</template>
