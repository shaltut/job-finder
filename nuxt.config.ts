// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@vueuse/nuxt'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/api/**': {
      cors: true
    }
  },

  // Pinned, not incidental: the Gmail OAuth client's redirect URI is registered against this exact
  // origin, and port 3000 is already taken on this machine. 3939 is the port the original UI used.
  devServer: {
    port: 3939,
    host: '127.0.0.1'
  },

  compatibilityDate: '2026-06-30',

  nitro: {
    // Replaces the original's launchd plist. Runs only while the dev server is up, which is the same
    // constraint the original had — nothing happens when nothing is running.
    experimental: { tasks: true },
    scheduledTasks: {
      // 08:07, not 08:00: every scheduler on the planet fires on the hour
      '7 8 * * *': ['daily'],
      // replies, for the Inbox view (server/tasks/inbox.ts)
      '*/5 * * * *': ['inbox'],
      // the scheduled scrape: decides whether a slot is due (server/tasks/schedule.ts)
      '*/10 * * * *': ['schedule']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
