<script setup lang="ts">
import type { Status } from '#shared/posts-view'

defineProps<{ count: number, status: Status, busy: boolean }>()
const emit = defineEmits<{ draft: [], dismiss: [], restore: [], applied: [], unapplied: [], exclude: [], clear: [] }>()
</script>

<template>
  <!-- The Dismissed and Applied views undo their own state; every other view triages. -->
  <div class="flex items-center gap-1.5">
    <span class="text-sm text-muted">{{ count }} selected</span>
    <UButton
      v-if="status === 'dismissed'"
      label="Restore"
      icon="i-lucide-undo-2"
      size="xs"
      color="neutral"
      variant="outline"
      :loading="busy"
      @click="emit('restore')"
    />
    <UButton
      v-else-if="status === 'applied'"
      label="Un-mark"
      icon="i-lucide-undo-2"
      size="xs"
      color="neutral"
      variant="outline"
      :loading="busy"
      @click="emit('unapplied')"
    />
    <template v-else>
      <UButton
        label="Draft"
        icon="i-lucide-pen-line"
        size="xs"
        color="primary"
        title="Screened like the batch run: posts that fail a hard rule are skipped with a reason"
        :loading="busy"
        @click="emit('draft')"
      />
      <UButton
        label="Applied"
        icon="i-lucide-check"
        size="xs"
        color="neutral"
        variant="outline"
        :loading="busy"
        @click="emit('applied')"
      />
      <UButton
        label="Dismiss"
        icon="i-lucide-x"
        size="xs"
        color="neutral"
        variant="outline"
        :loading="busy"
        @click="emit('dismiss')"
      />
      <UButton
        label="Exclude…"
        icon="i-lucide-ban"
        size="xs"
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="emit('exclude')"
      />
    </template>
    <UButton
      icon="i-lucide-x"
      size="xs"
      color="neutral"
      variant="ghost"
      aria-label="Clear selection"
      @click="emit('clear')"
    />
  </div>
</template>
