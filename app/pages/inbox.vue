<script setup lang="ts">
import type { InboxItem } from '~/types'

useDashboard()
useHead({ title: 'Inbox' })

const toast = useToast()
const { data: items, refresh } = await useFetch<InboxItem[]>('/api/inbox', { lazy: true, default: () => [] })
const open = ref<string | null>(null)
const notes = reactive<Record<string, string>>({})

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  // a queued draft finishes on the server; refresh while any is waiting
  timer = setInterval(() => {
    if (items.value.some(i => i.reply_status === 'queued')) refresh()
  }, 5000)
})
onUnmounted(() => clearInterval(timer))

const when = (s: number) => new Date(s * 1000).toLocaleString()
const gmailLink = (i: InboxItem) => `https://mail.google.com/mail/u/0/#all/${i.thread_id}`

const failed = (e: unknown) =>
  toast.add({ title: 'Failed', description: (e as { data?: { message?: string } })?.data?.message ?? String(e), color: 'error' })

/** The list and the sidebar badge (default.vue keys its fetch 'inbox-unread'). */
const reload = () => Promise.all([refresh(), refreshNuxtData('inbox-unread')])

async function toggle(i: InboxItem) {
  open.value = open.value === i.message_id ? null : i.message_id
  if (open.value && !i.read_at) {
    try {
      await $fetch('/api/inbox/read', { method: 'POST', body: { messageId: i.message_id } })
      i.read_at = Math.floor(Date.now() / 1000)
      refreshNuxtData('inbox-unread')
    } catch (e) {
      failed(e)
    }
  }
}

const syncing = ref(false)
/** Runs the 5-minute poll now: new replies in, and threads you answered in Gmail settled. */
async function sync() {
  syncing.value = true
  try {
    const r = await $fetch<{ result: string }>('/api/inbox/poll', { method: 'POST' })
    toast.add({ title: 'Inbox synced', description: r.result })
    await reload()
  } catch (e) {
    failed(e)
  } finally {
    syncing.value = false
  }
}

async function readAll() {
  try {
    await $fetch('/api/inbox/read', { method: 'POST', body: { all: true } })
    await reload()
  } catch (e) {
    failed(e)
  }
}

async function redraft(i: InboxItem) {
  try {
    const r = await $fetch<{ queued: boolean }>('/api/run/reply', { method: 'POST', body: { messageId: i.message_id, note: notes[i.message_id] ?? '' } })
    toast.add({ title: r.queued ? 'Reply queued' : 'Already queued', description: 'The draft lands in Gmail, in this thread.' })
    refresh()
  } catch (e) {
    failed(e)
  }
}

const STATUS: Record<string, { label: string, color: 'neutral' | 'success' | 'error' | 'warning' }> = {
  answered: { label: 'you replied', color: 'neutral' },
  queued: { label: 'drafting…', color: 'warning' },
  drafted: { label: 'draft in Gmail', color: 'success' },
  failed: { label: 'draft failed', color: 'error' },
  superseded: { label: 'replaced', color: 'neutral' }
}
</script>

<template>
  <UDashboardPanel id="inbox">
    <template #header>
      <UDashboardNavbar title="Inbox">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            label="Mark all read"
            icon="i-lucide-check-check"
            color="neutral"
            variant="ghost"
            :disabled="!items.some(i => !i.read_at)"
            @click="readAll"
          />
          <UButton
            label="Sync"
            icon="i-lucide-refresh-cw"
            :loading="syncing"
            @click="sync"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p
        v-if="!items.length"
        class="text-muted"
      >
        No replies yet. The inbox checks Gmail every 5 minutes.
      </p>
      <UCard
        v-for="i in items"
        :key="i.message_id"
        class="shrink-0"
      >
        <button
          class="w-full text-left"
          @click="toggle(i)"
        >
          <div class="flex items-center gap-2">
            <span :class="i.read_at ? 'text-muted' : 'font-semibold text-highlighted'">{{ i.from_addr }}</span>
            <UBadge
              v-if="i.reply_status && STATUS[i.reply_status]"
              :label="STATUS[i.reply_status]!.label"
              :color="STATUS[i.reply_status]!.color"
              variant="subtle"
            />
            <span class="ml-auto text-xs text-muted">{{ when(i.received_at) }}</span>
          </div>
          <div :class="i.read_at ? 'text-muted' : 'font-medium'">
            {{ i.subject }}
          </div>
        </button>

        <div
          v-if="open === i.message_id"
          class="mt-3 space-y-3"
        >
          <p class="whitespace-pre-wrap text-sm">
            {{ i.body }}
          </p>
          <UAlert
            v-if="i.questions.length"
            title="Needs your input"
            color="warning"
            variant="subtle"
            :description="i.questions.join(' · ')"
          />
          <p
            v-if="i.note"
            class="text-xs text-muted"
          >
            {{ i.note }}
          </p>
          <UTextarea
            v-if="i.reply_status !== 'answered'"
            v-model="notes[i.message_id]"
            placeholder="Optional: what the reply should say (e.g. Tuesday 2pm works)"
            :rows="2"
            class="w-full"
          />
          <div class="flex gap-2">
            <UButton
              v-if="i.reply_status !== 'answered'"
              label="Re-draft"
              icon="i-lucide-pen-line"
              @click="redraft(i)"
            />
            <UButton
              label="Open in Gmail"
              icon="i-lucide-external-link"
              color="neutral"
              variant="outline"
              :to="gmailLink(i)"
              target="_blank"
            />
          </div>
        </div>
      </UCard>
    </template>
  </UDashboardPanel>
</template>
