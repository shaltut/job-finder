<script setup lang="ts">
import { COUNTRIES } from '#shared/countries'
import { CONTACT_CHANNELS, type ContactChannel } from '#shared/settings'
import type { EditorToolbarItem } from '@nuxt/ui'
import type { AppConfig, GmailStatus, SettingsStatus } from '~/types'

useDashboard()
useHead({ title: 'Settings' })

const toast = useToast()
const { reflagAndWait } = useReflag()

const { data } = await useFetch<AppConfig>('/api/config')
// edit a copy: a failed save must leave the form as the user left it, not snap back
const form = ref<AppConfig>(structuredClone(toRaw(data.value!)))
const saving = ref(false)
const dirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(data.value))

/**
 * Three switches over one array, rebuilt in CONTACT_CHANNELS order every time.
 *
 * The order is the whole point: `dirty` above is a JSON.stringify comparison, so an array rebuilt in
 * the order the switches happened to be clicked would leave the page looking edited after a round trip
 * that changed nothing — the same trap EMPTY_SETTINGS' key order exists to avoid.
 */
const channelOn = (c: ContactChannel) => computed({
  get: () => form.value.contactChannels.includes(c),
  set: (on: boolean) => {
    const next = new Set(form.value.contactChannels)
    if (on) next.add(c)
    else next.delete(c)
    form.value.contactChannels = CONTACT_CHANNELS.filter(x => next.has(x))
  }
})
const emailOn = channelOn('email')
const linkOn = channelOn('link')
const phoneOn = channelOn('phone')

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
  // compared before adopt(), which overwrites the baseline this reads
  let rulesChanged = false
  try {
    // UInputTags does not trim, so whitespace would otherwise reach the schema
    form.value.terms = form.value.terms.map(s => s.trim()).filter(Boolean)
    form.value.titles = form.value.titles.map(s => s.trim()).filter(Boolean)
    form.value.excludes = form.value.excludes.map(s => s.trim()).filter(Boolean)
    rulesChanged = JSON.stringify(form.value.excludes) !== JSON.stringify(data.value?.excludes ?? [])
    const saved = await $fetch<AppConfig>('/api/config', { method: 'PUT', body: form.value })
    adopt(saved)
    await refreshStatus()
    toast.add({ title: 'Settings saved', color: 'success', icon: 'i-lucide-check' })
  } catch (e) {
    rulesChanged = false
    toast.add({
      title: 'Not saved',
      description: (e as { data?: { message?: string } })?.data?.message ?? String(e),
      color: 'error',
      duration: 8000
    })
  } finally {
    saving.value = false
  }

  // Outside the save entirely, and deliberately so — on both counts.
  //
  // Its own try/catch: the settings ARE saved by now, and a re-check that fails (a dev-server reload
  // mid-poll is routine) must not toast "Not saved" over a save that succeeded.
  //
  // After `saving` is cleared: reflag shares the scrape lane, so on a busy lane this waits minutes.
  // Holding the Save button disabled that whole time would show "saving" while nothing is being saved.
  if (!rulesChanged) return
  try {
    const { excluded, posts } = await reflagAndWait({
      onQueued: () => toast.add({
        title: 'Re-check queued',
        description: 'A scrape is running — stored posts will be re-checked when it finishes.',
        icon: 'i-lucide-clock'
      })
    })
    toast.add({
      title: `Re-flagged ${posts} posts`,
      description: `${excluded} now excluded.`,
      color: 'success',
      icon: 'i-lucide-filter'
    })
  } catch {
    toast.add({
      title: 'Saved, but the re-check did not run',
      description: 'Your rules apply to the next scrape. Press Reflag in the Run view to apply them to stored posts.',
      color: 'warning',
      duration: 8000
    })
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

/**
 * Evidence is edited as rich text but STORED as markdown — `content-type="markdown"` on the editor,
 * not the default. The stored string goes verbatim into the drafter's system prompt, and the whole
 * point of that prompt is that a human can read it and check what the model was told; a wall of
 * serialised HTML would end that.
 *
 * Bubble layout rather than a fixed bar: this sits inside a settings form, and a permanent toolbar
 * reads as another control to fill in rather than as formatting for the text you selected.
 */
const evidenceTools: EditorToolbarItem[][] = [[
  { kind: 'mark', mark: 'bold', icon: 'i-lucide-bold', tooltip: { text: 'Bold' } },
  { kind: 'mark', mark: 'italic', icon: 'i-lucide-italic', tooltip: { text: 'Italic' } },
  { kind: 'bulletList', icon: 'i-lucide-list', tooltip: { text: 'Bullet list' } },
  { kind: 'heading', level: 2, icon: 'i-lucide-heading-2', tooltip: { text: 'Heading' } },
  { kind: 'clearFormatting', icon: 'i-lucide-remove-formatting', tooltip: { text: 'Clear formatting' } }
]]

const generating = ref(false)
const discarded = ref<string[]>([])
const discardedCount = ref(0)

/**
 * Proposes the evidence, gaps and strengths an application argues from. Same contract as prefill —
 * the proposal lands in the form and nothing is stored until you press Save.
 *
 * `replace` is the difference. Filling only what is blank is right the first time and wrong every
 * time after: update your CV, press Generate, and a fill-if-empty merge would silently do nothing.
 * So a second press asks first, and then overwrites.
 */
async function generateBackground() {
  const hasContent = !!form.value.background.evidence || form.value.background.gaps.length > 0

  if (hasContent && !confirm('Replace the evidence and gaps below with a fresh reading of your CV?')) return

  generating.value = true
  discarded.value = []
  discardedCount.value = 0
  try {
    const r = await $fetch<{
      config: AppConfig
      filled: string[]
      dropped: { why: string }[]
    }>('/api/settings/background', { method: 'POST', body: { ...form.value, replace: hasContent } })
    form.value = structuredClone(r.config)
    // surfaced rather than swallowed: a rising count is how you notice the prompt drifting
    discardedCount.value = (r.dropped ?? []).length
    discarded.value = [...new Set((r.dropped ?? []).map(d => d.why))]
    toast.add({
      title: r.filled.length ? 'Background generated' : 'Nothing changed',
      description: r.filled.length
        ? `${r.filled.join(', ')}. Read every gap before saving — a gap you do not have makes every email apologise for nothing.`
        : 'The model proposed nothing new.',
      color: r.filled.length ? 'success' : 'neutral',
      icon: r.filled.length ? 'i-lucide-sparkles' : 'i-lucide-info',
      duration: 10000
    })
  } catch (e) {
    toast.add({
      title: 'Could not generate the background',
      description: (e as { data?: { message?: string } })?.data?.message ?? String(e),
      color: 'error',
      duration: 8000
    })
  } finally {
    generating.value = false
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
              label="Working hours"
              help="Roles outside this window get flagged."
            >
              <UInput
                v-model="form.constraints.workingHours"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Expected salary"
              help="Quoted verbatim when a post asks for one. Left empty, a post that demands a figure is skipped rather than drafted with a blank in it."
            >
              <UInput
                v-model="form.constraints.expectedSalary"
                class="w-full"
                placeholder="e.g. 8,000 USD / month, or a range"
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
            Field and level
          </h2>
          <p class="text-sm text-muted">
            What counts as a match. These reach the scoring prompt and the drafter, so a role in
            another field scores low instead of competing with real ones.
          </p>
        </template>

        <div class="space-y-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              label="Field of work"
              help="Two or three words, as someone in it would say. Any profession."
            >
              <UInput
                v-model="form.scope.roleFamily"
                placeholder="e.g. frontend engineering"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Seniority floor"
              help="Postings asking for this many years or fewer are flagged as junior. 0 turns it off."
            >
              <UInput
                v-model.number="form.scope.seniorityFloor"
                type="number"
                :min="0"
                :max="50"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField
            label="Primary skills"
            help="What you would be hired for. Roles built on these score highest."
          >
            <UInputTags
              v-model="form.scope.primarySkills"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Secondary skills"
            help="Things you also work with, but less, or less recently."
          >
            <UInputTags
              v-model="form.scope.secondarySkills"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Out of scope"
            help="Neighbouring jobs that are not yours. Naming them is what stops a shared title word pulling them in."
          >
            <UInputTags
              v-model="form.scope.excludedRoles"
              class="w-full"
            />
          </UFormField>
        </div>
      </UCard>

      <UCard class="shrink-0">
        <template #header>
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-highlighted">
              Application background
            </h2>
            <UBadge
              :color="form.background.evidence ? 'success' : 'warning'"
              variant="subtle"
              size="sm"
            >
              {{ form.background.evidence ? 'ready to draft' : 'drafting blocked' }}
            </UBadge>
          </div>
          <p class="text-sm text-muted">
            The only facts an application email may use, and the gaps it must declare. Drafting will
            not start without evidence — an email with nothing behind it is the one this tool exists
            to avoid.
          </p>
        </template>

        <div class="space-y-4">
          <UFormField
            label="Evidence"
            help="Roles, dates, named work, scale, qualifications — in the CV's own words. Every claim in every email must trace to something here."
          >
            <UEditor
              v-slot="{ editor }"
              v-model="form.background.evidence"
              content-type="markdown"
              placeholder="Generate from CV, then edit."
              class="w-full min-h-80 max-h-[32rem] overflow-y-auto rounded-md ring ring-accented p-3 text-sm"
            >
              <UEditorToolbar
                :editor="editor"
                :items="evidenceTools"
                layout="bubble"
              />
            </UEditor>
          </UFormField>

          <UFormField
            label="Gaps"
            help="Declared honestly in the email, never papered over. Delete any that are not true of you — an invented gap makes every application apologise for nothing."
          >
            <UInputTags
              v-model="form.background.gaps"
              class="w-full"
            />
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              label="Strengths"
              help="Scarce in your market. A posting asking for these ranks higher."
            >
              <UInputTags
                v-model="form.background.strengths"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Never claim"
              help="Figures your CV marks as estimates. The email uses hard numbers instead."
            >
              <UInputTags
                v-model="form.background.neverClaim"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <UButton
              icon="i-lucide-sparkles"
              :loading="generating"
              :disabled="!status.cvExists || generating || !form.titles.length"
              @click="generateBackground"
            >
              Generate from CV
            </UButton>
            <p class="text-sm text-muted">
              <template v-if="!status.cvExists">
                Upload a CV first.
              </template>
              <template v-else-if="!form.titles.length">
                Add target titles below first — they are what gaps are measured against.
              </template>
              <template v-else>
                Reads your CV against your target titles. Review every line, then press Save.
              </template>
            </p>
          </div>
          <p
            v-if="discarded.length"
            class="text-xs text-muted"
          >
            {{ discardedCount }} proposed gap(s) discarded: {{ discarded.join('; ') }}
          </p>
        </div>
      </UCard>

      <UCard class="shrink-0">
        <template #header>
          <h2 class="font-semibold text-highlighted">
            Contact types
          </h2>
          <p class="text-sm text-muted">
            Which posts are worth storing. A post is kept when it offers at least one of these, and every
            switch you turn on widens what a scrape brings back — and what it costs to score.
          </p>
        </template>

        <div class="space-y-3">
          <USwitch
            v-model="emailOn"
            label="An email address"
            description="The only route this tool can draft for. Leave it on unless you never want a draft."
          />
          <USwitch
            v-model="linkOn"
            label="An application link"
            description="Kept only when the post invites an application through it — LinkedIn hides where a link goes, so the surrounding words are the only evidence. You apply to these yourself."
          />
          <USwitch
            v-model="phoneOn"
            label="A phone or WhatsApp number"
            description="Common in some markets and invisible to the email filter. You apply to these yourself."
          />
          <p
            v-if="!form.contactChannels.length"
            class="text-sm text-error"
          >
            With all three off a scrape stores nothing, so it will refuse to start.
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
              placeholder="e.g. senior &lt;your role&gt; hiring"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Target titles"
            :help="`${form.titles.length} titles, fed to the scoring prompt`"
          >
            <UInputTags
              v-model="form.titles"
              placeholder="e.g. Senior &lt;Your Title&gt;"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Never show posts mentioning"
            :help="`${form.excludes.length} rule${form.excludes.length === 1 ? '' : 's'} — matched against the whole post, so a domain, a company or a person's name all work. Whole words only: &quot;ai&quot; will not match &quot;email&quot;.`"
          >
            <UInputTags
              v-model="form.excludes"
              placeholder="e.g. example.com"
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
