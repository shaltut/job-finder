import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dbCredentials: { url: process.env.JOBFINDER_DB || 'data/jobfinder.db' }
})
