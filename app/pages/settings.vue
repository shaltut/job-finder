<script setup lang="ts">
import { COUNTRIES } from '#shared/countries'
import type { AppConfig, GmailStatus, SettingsStatus } from '~/types'

useDashboard()
useHead({ title: 'Settings' })

const toast = useToast()

const { data } = await useFetch<AppConfig>('/api/config')
// edit a copy: a failed save must leave the form as the user left it, not snap back
const form = ref<AppConfig>(structuredClone(toRaw(data.value!)))
const saving = ref(false)
const dirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(data.value))

// the full ISO list. Names are the stored value, so this binds straight to the string arrays.
const COUNTRY_NAMES = COUNTRIES.map(c => c.name)

const { data: status, refresh: refreshStatus } = await useFetch<SettingsStatus>('/api/settings/status', {
  lazy: true,
  default: () => ({ missing: [], ready: true, cv: '', cvExists: false })
})

/** Adopt whatever the server stored, and reset the dirty baseline with it. */
function adopt(saved: AppConfig) {
  data.value = structuredClone(saved)
  form.value = structuredClone(saved)
}

async function save() {
  saving.value = true
  try {
    // UInputTags does not trim, so whitespace would otherwise reach the schema
    form.value.terms = form.value.terms.map(s => s.trim()).filter(Boolean)
    form.value.titles = form.value.titles.map(s => s.trim()).filter(Boolean)
    const saved = await $fetch<AppConfig>('/api/config', { method: 'PUT', body: form.value })
    adopt(saved)
    await refreshStatus()
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

// ---------------- CV ----------------

const cvFile = ref<File | null>(null)
const uploading = ref(false)
const prefilling = ref(false)

/**
 * The upload writes `cv` straight to the database, outside this form. Both copies have to be
 * re-synced from the response or the next Save would send the pre-upload path and silently
 * overwrite the file we just stored — leaving the scraper with a CV that is not there.
 */
async function uploadCv(file: File) {
  uploading.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    const r = await $fetch<{ config: AppConfig, cv: string, bytes: number }>('/api/settings/cv', { method: 'POST', body })
    // Only `cv` moves. Adopting the whole stored config here would throw away anything typed into
    // the form but not yet saved — drop a CV after editing your name and the name would vanish.
    // Updating the baseline as well keeps `dirty` honest: equal iff there were no other edits.
    data.value = structuredClone(r.config)
    form.value.cv = r.cv
    await refreshStatus()
    toast.add({
      title: 'CV uploaded',
      description: `${r.cv} · ${(r.bytes / 1024 / 1024).toFixed(1)} MB`,
      color: 'success',
      icon: 'i-lucide-check'
    })
  } catch (e) {
    toast.add({
      title: 'Upload failed',
      description: (e as { data?: { message?: string } })?.data?.message ?? String(e),
      color: 'error',
      duration: 8000
    })
  } finally {
    uploading.value = false
    cvFile.value = null
  }
}

watch(cvFile, (f) => {
  if (f) uploadCv(f)
})

/**
 * Reads the CV and proposes values for the fields that are still blank. Nothing is saved: the
 * proposal lands in the form and you press Save, so you always see what the model produced.
 */
async function prefill() {
  prefilling.value = true
  try {
    // the form, not the stored row: clearing a field and pressing Prefill has to re-read it from the
    // CV, and the server would otherwise still see the value you just cleared
    const r = await $fetch<{ config: AppConfig, filled: string[] }>('/api/settings/prefill', { method: 'POST', body: form.value })
    form.value = structuredClone(r.config)
    toast.add({
      title: r.filled.length ? `Filled ${r.filled.length} empty ${r.filled.length === 1 ? 'field' : 'fields'}` : 'Nothing to fill',
      description: r.filled.length
        ? `${r.filled.join(', ')}. Review, then press Save — nothing is stored yet.`
        : 'Every field was already set. Clear one first if you want it re-read from the CV.',
      color: r.filled.length ? 'success' : 'neutral',
      icon: r.filled.length ? 'i-lucide-sparkles' : 'i-lucide-info',
      duration: 8000
    })
  } catch (e) {
    toast.add({
      title: 'Could not read the CV',
      description: (e as { data?: { message?: string } })?.data?.message ?? String(e),
      color: 'error',
      duration: 8000
    })
  } finally {
    prefilling.value = false
  }
}

// ---------------- Gmail ----------------

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
      <UAlert
        v-if="status.missing.length"
        class="shrink-0"
        icon="i-lucide-triangle-alert"
        color="warning"
        variant="subtle"
        title="Settings are incomplete — scrapes and drafts will not start"
        :description="status.missing.join(' · ')"
      />

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
          <UFormField
            label="On-site or hybrid roles are in scope in"
            help="Anywhere not listed here scores 0-2 unless the role is location-free remote."
          >
            <UInputMenu
              v-model="form.constraints.onsiteCountries"
              multiple
              :items="COUNTRY_NAMES"
              placeholder="Search countries…"
              icon="i-lucide-map-pin"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Willing to relocate to"
            help="Stated verbatim in application emails, so keep it true."
          >
            <UInputMenu
              v-model="form.constraints.willRelocate"
              multiple
              :items="COUNTRY_NAMES"
              placeholder="Search countries…"
              icon="i-lucide-plane"
              class="w-full"
            />
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
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-highlighted">
              CV
            </h2>
            <UBadge
              :color="status.cvExists ? 'success' : 'neutral'"
              variant="subtle"
            >
              {{ status.cvExists ? 'stored' : 'not set' }}
            </UBadge>
          </div>
          <p class="text-sm text-muted">
            Read by the scoring model on every run and attached to every draft. Stored under
            <code class="text-xs">data/cv/</code>, which git ignores.
          </p>
        </template>

        <div class="space-y-4">
          <UFileUpload
            v-model="cvFile"
            accept="application/pdf"
            :disabled="uploading"
            icon="i-lucide-file-text"
            label="Drop your CV here"
            description="A single PDF, up to 10 MB"
            class="w-full min-h-40"
          />

          <div class="flex flex-wrap items-center gap-3">
            <UButton
              label="Prefill from CV"
              icon="i-lucide-sparkles"
              color="neutral"
              variant="outline"
              :loading="prefilling"
              :disabled="!status.cvExists || uploading"
              @click="prefill"
            />
            <p class="text-xs text-muted">
              Fills only the fields that are still empty, and never the constraints above — a CV
              cannot know where you will relocate to. Nothing is saved until you press Save.
            </p>
          </div>

          <p
            v-if="status.cv"
            class="font-mono text-xs text-muted"
          >
            {{ status.cv }}
          </p>
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
            :help="`${form.terms.length} terms — type one and press Enter`"
          >
            <UInputTags
              v-model="form.terms"
              placeholder="e.g. vue nuxt developer"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Target titles"
            :help="`${form.titles.length} titles, fed to the scoring prompt`"
          >
            <UInputTags
              v-model="form.titles"
              placeholder="e.g. Senior Frontend Engineer"
              class="w-full"
            />
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-2">
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
            class="space-y-3"
          >
            <div class="flex flex-wrap items-center gap-3 text-sm">
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
            <p class="text-xs text-muted">
              Holds <code>gmail.compose</code> and <code>gmail.readonly</code>: it can create drafts and read
              your mail. It cannot delete anything, and it never sends &mdash; that is enforced in the code, not
              by the scope. If your Google app is in Testing rather than In production, this lapses after 7 days
              and you press Connect again.
            </p>
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

          <GmailSetup
            v-else
            :redirect="gmail.redirect"
          />
        </div>
      </UCard>
    </template>
  </UDashboardPanel>
</template>
