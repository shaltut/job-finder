<script setup lang="ts">
/**
 * The Google Cloud walkthrough, in the app. It is long because the Console genuinely fights you at four
 * points, and each trap below cost real time the first time through. Collapsed once connected.
 */
const props = defineProps<{ redirect: string }>()

const open = ref(false)

const steps = [
  {
    n: 1,
    title: 'Create a Google Cloud project',
    url: 'https://console.cloud.google.com/projectcreate',
    body: 'Any name. Remember which project it is — the next step is where this usually goes wrong.'
  },
  {
    n: 2,
    title: 'Enable the Gmail API on that same project',
    url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    body: 'Check the project picker at the top matches, then press Enable. Enabling it on a different project than the one that owns the client makes every call fail with "Gmail API has not been used in project <number>".',
    trap: 'Ignore the "Create credentials" banner that appears afterwards. One path in that wizard creates a service account, which cannot reach a personal Gmail at all — it needs Google Workspace domain-wide delegation. You would finish the whole flow and find it never authenticates.'
  },
  {
    n: 3,
    title: 'Branding — fill this in first',
    url: 'https://console.cloud.google.com/auth/branding',
    body: 'App name, user support email, developer contact email.',
    trap: 'Publishing stays greyed out until Branding is complete, and the Audience page only vaguely points you back here.'
  },
  {
    n: 4,
    title: 'Data Access — add three scopes',
    url: 'https://console.cloud.google.com/auth/scopes',
    body: 'Add or remove scopes, paste each into the filter box, tick it, Update, Save. The first two are labelled Restricted — expected.',
    scopes: [
      ['https://www.googleapis.com/auth/gmail.compose', 'create drafts'],
      ['https://www.googleapis.com/auth/gmail.readonly', 'read sent mail, so the sweep knows what you sent'],
      ['https://www.googleapis.com/auth/userinfo.email', 'read back which account connected']
    ]
  },
  {
    n: 5,
    title: 'Audience — choose Testing or In production',
    url: 'https://console.cloud.google.com/auth/audience',
    body: 'User type External. Add yourself under Test users either way — it costs nothing and lets you connect even if publishing is blocked.',
    trap: 'Publishing to production also demands a working homepage URL and privacy policy URL. If you have no site to point at, stay in Testing and accept that the refresh token expires every 7 days. If you do publish, ignore the "requires verification" banner — verification is for apps with real users.'
  },
  {
    n: 6,
    title: 'Create the OAuth client',
    url: 'https://console.cloud.google.com/auth/clients',
    body: 'Create OAuth client → Application type: Desktop app → Create.',
    trap: `There is no redirect URI field for Desktop clients, and that is correct — loopback is allowed automatically. The downloaded file says "redirect_uris": ["http://localhost"] while this app calls back on ${props.redirect}. That mismatch is fine: Google treats the two hosts as equivalent for Desktop clients and ignores the port.`
  },
  {
    n: 7,
    title: 'Download and rename the JSON',
    body: 'Google names it client_secret_<long-id>.apps.googleusercontent.com.json. Rename it to exactly google-oauth.json in the project folder, then reload this page.'
  }
]

const errors = [
  ['Gmail API has not been used in project <number>', 'The API is enabled on a different project than the client. Redo step 2 in the right project.'],
  ['redirect_uri_mismatch', 'Rare for Desktop clients. Set JOBFINDER_REDIRECT=http://localhost:3939/api/gmail/callback in .env and restart.'],
  ['state mismatch: start from Connect Gmail…', 'You reached the callback without starting from Connect, or the server restarted mid-consent. Press Connect again — this is a deliberate CSRF guard.'],
  ['access_denied', 'The app is in Testing and your address is not a test user. Step 5.'],
  ['Connected, then "not connected" a week later', 'Testing mode: refresh tokens expire after 7 days. Reconnect, or publish the app.']
]
</script>

<template>
  <div class="space-y-4 text-sm">
    <div class="flex items-start gap-2">
      <UIcon
        name="i-lucide-circle-alert"
        class="size-4 mt-0.5 shrink-0 text-warning"
      />
      <p class="text-highlighted">
        <code class="text-xs">google-oauth.json</code> is missing. It takes about fifteen minutes, and the
        Console fights you at four points — each is called out below.
      </p>
    </div>

    <UButton
      :label="open ? 'Hide the walkthrough' : 'Show the full walkthrough'"
      :icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
      color="neutral"
      variant="outline"
      size="sm"
      @click="open = !open"
    />

    <div
      v-if="open"
      class="space-y-5 border-l-2 border-default pl-4"
    >
      <div
        v-for="s in steps"
        :key="s.n"
        class="space-y-1.5"
      >
        <p class="font-medium text-highlighted">
          {{ s.n }}. {{ s.title }}
        </p>
        <p class="text-muted">
          {{ s.body }}
        </p>

        <ULink
          v-if="s.url"
          :to="s.url"
          target="_blank"
          class="inline-flex items-center gap-1 text-xs font-mono break-all"
        >
          {{ s.url }}
          <UIcon
            name="i-lucide-external-link"
            class="size-3 shrink-0"
          />
        </ULink>

        <ul
          v-if="s.scopes"
          class="mt-1 space-y-1"
        >
          <li
            v-for="[scope, why] in s.scopes"
            :key="scope"
            class="text-xs"
          >
            <code class="break-all">{{ scope }}</code>
            <span class="text-muted"> — {{ why }}</span>
          </li>
        </ul>

        <div
          v-if="s.trap"
          class="mt-1.5 flex items-start gap-2 rounded-md bg-warning/10 p-2.5"
        >
          <UIcon
            name="i-lucide-triangle-alert"
            class="size-4 mt-0.5 shrink-0 text-warning"
          />
          <p class="text-xs text-toned">
            {{ s.trap }}
          </p>
        </div>
      </div>

      <div class="space-y-1.5">
        <p class="font-medium text-highlighted">
          When it goes wrong
        </p>
        <div
          v-for="[symptom, cause] in errors"
          :key="symptom"
          class="text-xs"
        >
          <code class="break-all">{{ symptom }}</code>
          <p class="text-muted">
            {{ cause }}
          </p>
        </div>
      </div>

      <p class="text-xs text-muted">
        Do not restart the dev server between pressing Connect and finishing consent: the one-shot CSRF nonce
        lives in the running process. It survives hot-reloads, not a restart.
      </p>
    </div>
  </div>
</template>
