<script setup lang="ts">
import type { AppConfig, GmailStatus } from '~/types'

useDashboard()
useHead({ title: 'Settings' })

const toast = useToast()

const { data, refresh } = await useFetch<AppConfig>('/api/config')
// edit a copy: a failed save must leave the form as the user left it, not snap back
const form = ref<AppConfig>(structuredClone(toRaw(data.value!)))
const saving = ref(false)
const dirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(data.value))

const COUNTRIES = ['Egypt', 'Saudi Arabia', 'UAE', 'Qatar', 'Kuwait', 'Bahrain', 'Oman', 'Jordan']

function toggle(list: string[], value: string) {
  const i = list.indexOf(value)
  if (i < 0) list.push(value)
  else list.splice(i, 1)
}

async function save() {
  saving.value = true
  try {
    const saved = await $fetch<AppConfig>('/api/config', { method: 'PUT', body: form.value })
    await refresh()
    form.value = structuredClone(toRaw(saved))
    toast.add({ title: 'Settings saved', color: 'success', icon: 'i-lucide-check' })
  } catch (e) {
    toast.add({
      title: 'Not saved',
      description: (e as { data?: { message?: string } })?.data?.message ?? String(e),
      color: 'error',
      duration: 8000
    })
  } finally {
    saving.value = false
  }
}

function reset() {
  form.value = structuredClone(toRaw(data.value!))
}

const { data: gmail, refresh: refreshGmail } = await useFetch<GmailStatus>('/api/gmail/status', {
  lazy: true,
  default: () => ({ configured: false, authorized: false, email: null, expected: null, mismatch: false, redirect: '' })
})

async function disconnectGmail() {
  await $fetch('/api/gmail/disconnect', { method: 'POST' })
  await refreshGmail()
  toast.add({ title: 'Gmail disconnected' })
}
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            v-if="dirty"
            label="Discard"
            color="neutral"
            variant="ghost"
            @click="reset"
          />
          <UButton
            label="Save"
            icon="i-lucide-save"
            :loading="saving"
            :disabled="!dirty"
            @click="save"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UCard class="shrink-0">
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Profile
          </h2>
          <p class="text-sm text-muted">
            Used in the scoring prompt, the drafter's system prompt, and the signature on every draft.
          </p>
        </template>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Name">
            <UInput
              v-model="form.profile.name"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Title">
            <UInput
              v-model="form.profile.title"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Location">
            <UInput
              v-model="form.profile.location"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Email"
            help="Also the Gmail account the pipeline expects to send from."
          >
            <UInput
              v-model="form.profile.email"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Phone">
            <UInput
              v-model="form.profile.phone"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Years of experience">
            <UInput
              v-model="form.profile.yearsExperience"
              class="w-full"
            />
          </UFormField>
          <UFormField label="LinkedIn">
            <UInput
              v-model="form.profile.linkedin"
              class="w-full"
            />
          </UFormField>
          <UFormField label="GitHub">
            <UInput
              v-model="form.profile.github"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Languages"
            class="sm:col-span-2"
          >
            <UInput
              v-model="form.profile.languages"
              class="w-full"
            />
          </UFormField>
        </div>
      </UCard>

      <UCard class="shrink-0">
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Constraints
          </h2>
          <p class="text-sm text-muted">
            What the scorer treats as in scope, and what the drafter is allowed to promise.
          </p>
        </template>

        <div class="space-y-5">
          <UFormField label="On-site or hybrid roles are in scope in">
            <div class="flex flex-wrap gap-1.5">
              <UButton
                v-for="c in COUNTRIES"
                :key="c"
                :label="c"
                size="sm"
                :color="form.constraints.onsiteCountries.includes(c) ? 'primary' : 'neutral'"
                :variant="form.constraints.onsiteCountries.includes(c) ? 'subtle' : 'outline'"
                @click="toggle(form.constraints.onsiteCountries, c)"
              />
            </div>
          </UFormField>

          <UFormField
            label="Willing to relocate to"
            help="Stated verbatim in application emails, so keep it true."
          >
            <div class="flex flex-wrap gap-1.5">
              <UButton
                v-for="c in COUNTRIES"
                :key="c"
                :label="c"
                size="sm"
                :color="form.constraints.willRelocate.includes(c) ? 'primary' : 'neutral'"
                :variant="form.constraints.willRelocate.includes(c) ? 'subtle' : 'outline'"
                @click="toggle(form.constraints.willRelocate, c)"
              />
            </div>
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              label="Stack weighting"
              help="Which stack scores highest."
            >
              <USelect
                v-model="form.constraints.stackWeighting"
                :items="[
                  { label: 'Vue/Nuxt primary, React secondary', value: 'vue-primary' },
                  { label: 'Weight both equally', value: 'equal' },
                  { label: 'React/Next primary', value: 'react-primary' }
                ]"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Working hours"
              help="Roles outside this window get flagged."
            >
              <UInput
                v-model="form.constraints.workingHours"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="space-y-3">
            <USwitch
              v-model="form.constraints.remoteAnywhere"
              label="Accept location-free remote roles from anywhere"
            />
            <USwitch
              v-model="form.constraints.canStartImmediately"
              label="Can start immediately"
              description="When off, posts demanding immediate joiners are treated as a mismatch."
            />
          </div>
        </div>
      </UCard>

      <UCard class="shrink-0">
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Search
          </h2>
          <p class="text-sm text-muted">
            Terms are searched one at a time. The literal term <code class="text-xs">feed</code> scrapes your own
            LinkedIn home feed instead of a search.
          </p>
        </template>

        <div class="space-y-4">
          <UFormField
            label="Search terms"
            :help="`${form.terms.length} terms`"
          >
            <UTextarea
              :model-value="form.terms.join('\n')"
              :rows="9"
              class="w-full font-mono text-xs"
              @update:model-value="form.terms = String($event).split('\n').map(s => s.trim()).filter(Boolean)"
            />
          </UFormField>

          <UFormField
            label="Target titles"
            :help="`${form.titles.length} titles, fed to the scoring prompt`"
          >
            <UTextarea
              :model-value="form.titles.join('\n')"
              :rows="8"
              class="w-full font-mono text-xs"
              @update:model-value="form.titles = String($event).split('\n').map(s => s.trim()).filter(Boolean)"
            />
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField label="Max cards per term">
              <UInput
                v-model.number="form.max"
                type="number"
                :min="1"
                :max="200"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Posted within">
              <USelect
                v-model="form.since"
                :items="[
                  { label: 'Past 24 hours', value: 'past-24h' },
                  { label: 'Past week', value: 'past-week' },
                  { label: 'Past month', value: 'past-month' }
                ]"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="CV PDF"
              help="Read by the scoring model and attached to every draft."
            >
              <UInput
                v-model="form.cv"
                class="w-full font-mono text-xs"
              />
            </UFormField>
          </div>
        </div>
      </UCard>

      <UCard class="shrink-0">
        <template #header>
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-highlighted">
              Gmail
            </h2>
            <UBadge
              :color="gmail.authorized ? 'success' : 'neutral'"
              variant="subtle"
            >
              {{ gmail.authorized ? 'connected' : 'not connected' }}
            </UBadge>
          </div>
          <p class="text-sm text-muted">
            Drafts only. Nothing in this app can send an email.
          </p>
        </template>

        <div class="space-y-4">
          <UAlert
            v-if="gmail.mismatch"
            icon="i-lucide-triangle-alert"
            color="warning"
            variant="subtle"
            title="Connected account does not match your profile"
            :description="`Connected as ${gmail.email}, but Settings says ${gmail.expected}. The stage sweep matches sent mail by sender, so follow-ups would misfire.`"
          />

          <div
            v-if="gmail.authorized"
            class="flex flex-wrap items-center gap-3 text-sm"
          >
            <UIcon
              name="i-lucide-check-circle-2"
              class="size-5 text-success"
            />
            <span class="text-highlighted font-mono text-xs">{{ gmail.email }}</span>
            <UButton
              label="Disconnect"
              size="xs"
              color="neutral"
              variant="outline"
              class="ml-auto"
              @click="disconnectGmail"
            />
          </div>

          <div
            v-else-if="gmail.configured"
            class="flex flex-wrap items-center gap-3"
          >
            <UButton
              label="Connect Gmail"
              icon="i-lucide-plug-zap"
              to="/api/gmail/auth"
              external
            />
            <span class="text-sm text-muted">Opens Google's consent screen.</span>
          </div>

          <div
            v-else
            class="space-y-2 text-sm"
          >
            <p class="text-highlighted">
              <UIcon
                name="i-lucide-circle-alert"
                class="size-4 align-text-bottom"
              />
              <code class="text-xs">google-oauth.json</code> is missing.
            </p>
            <ol class="list-decimal ml-5 space-y-1 text-muted">
              <li>Create a Google Cloud project and <strong>enable the Gmail API on that same project</strong>.</li>
              <li>
                OAuth consent screen &rarr; publishing status <strong>In production</strong>
                (in Testing, refresh tokens die after 7 days).
              </li>
              <li>
                Scopes <code class="text-xs">gmail.compose</code> and <code class="text-xs">gmail.readonly</code>.
              </li>
              <li>
                Create an OAuth client of type <strong>Desktop app</strong>. There is no redirect URI field
                for this type &mdash; loopback is allowed automatically, and this app uses
                <code class="text-xs">{{ gmail.redirect }}</code>.
              </li>
              <li>
                Download the client JSON as <code class="text-xs">google-oauth.json</code> in the project folder,
                then reload this page.
              </li>
            </ol>
          </div>
        </div>
      </UCard>
    </template>
  </UDashboardPanel>
</template>
