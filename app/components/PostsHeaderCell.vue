<script setup lang="ts">
import type { Dir, Sort } from '#shared/posts-view'

const props = defineProps<{
  label: string
  sortCol?: Exclude<Sort, 'default'>
  sort: Sort
  dir: Dir
  /** this column's filter differs from its default — the filter button stays visible and highlighted */
  active?: boolean
}>()
const emit = defineEmits<{ sort: [] }>()
const slots = defineSlots<{ default?: () => unknown }>()

const sorted = computed(() => !!props.sortCol && props.sort === props.sortCol)
const ariaSort = computed(() => (sorted.value ? (props.dir === 'asc' ? 'ascending' : 'descending') : undefined))
</script>

<template>
  <!-- The filter button is absolutely positioned into the 32px of padding between this header and the
       next, so it takes no width: the table has none to spare (1152px in 1152 at 1440), and opacity alone
       still reserves the space — measured 91px of overflow when it did. `group`: it shows on hover or
       keyboard focus, and stays while the column's filter is active. -->
  <div
    class="group relative inline-flex items-center gap-0.5 whitespace-nowrap"
    :aria-sort="ariaSort"
  >
    <button
      v-if="sortCol"
      type="button"
      class="inline-flex items-center gap-0.5 font-semibold hover:text-highlighted"
      :title="`Sort by ${label}`"
      @click="emit('sort')"
    >
      {{ label }}
      <UIcon
        v-if="sorted"
        :name="dir === 'asc' ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down'"
        class="size-3.5"
      />
    </button>
    <span
      v-else
      class="font-semibold"
    >{{ label }}</span>
    <span
      v-if="slots.default"
      class="absolute left-full top-1/2 -translate-y-1/2 z-10"
    >
      <UPopover>
        <UButton
          icon="i-lucide-list-filter"
          size="xs"
          :color="active ? 'primary' : 'neutral'"
          variant="ghost"
          :aria-label="`Filter by ${label}`"
          :class="active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'"
        />
        <template #content>
          <div class="p-3 min-w-48 space-y-3">
            <slot />
          </div>
        </template>
      </UPopover>
    </span>
  </div>
</template>
