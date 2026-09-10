<script setup lang="ts">
import type { AppConfig } from '~/types'

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
          <h2 class="font-semibold text-highlighted">
            Gmail
          </h2>
        </template>
        <div class="flex items-center gap-3">
          <UIcon
            name="i-lucide-plug-zap"
            class="size-5 text-muted"
          />
          <div class="text-sm">
            <p class="text-highlighted">
              Not connected yet
            </p>
            <p class="text-muted">
              Drafting lands in M3 and Gmail in M4. Connecting needs a Google Cloud OAuth desktop client
              with the <code class="text-xs">gmail.compose</code> and <code class="text-xs">gmail.readonly</code> scopes.
            </p>
          </div>
        </div>
      </UCard>
    </template>
  </UDashboardPanel>
</template>
