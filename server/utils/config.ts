// config.json is the single place the profile, constraints and search settings live. The Settings page is
// a form over this schema; the scoring prompt and the drafter's system prompt are built from it at run time.
// Nothing here is hardcoded in the source, so retargeting the tool is data entry, not editing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const CONFIG_PATH = resolve(process.cwd(), 'config.json')

export const configSchema = z.object({
  profile: z.object({
    name: z.string().trim().min(1),
    title: z.string().trim().min(1),
    location: z.string().trim().min(1),
    // lower-cased so it matches the Gmail sender check and the contacts constraint
    email: z.string().trim().email().toLowerCase(),
    phone: z.string().trim().min(1),
    linkedin: z.string().trim().url(),
    github: z.string().trim().url().or(z.literal('')),
    languages: z.string().trim(),
    yearsExperience: z.string().trim()
  }),
  constraints: z.object({
    remoteAnywhere: z.boolean(),
    onsiteCountries: z.array(z.string().trim().min(1)),
    willRelocate: z.array(z.string().trim().min(1)),
    canStartImmediately: z.boolean(),
    workingHours: z.string().trim().min(1),
    stackWeighting: z.enum(['vue-primary', 'equal', 'react-primary'])
  }),
  // the model reads this PDF itself once per run, so a wrong path must fail here, not mid-scrape
  cv: z.string().trim().min(1).refine(p => existsSync(p), { message: 'file does not exist' }),
  terms: z.array(z.string().trim().min(1)).min(1, 'at least one search term'),
  titles: z.array(z.string().trim().min(1)).min(1, 'at least one target title'),
  max: z.number().int().min(1).max(200),
  since: z.enum(['past-24h', 'past-week', 'past-month'])
})

export type AppConfig = z.infer<typeof configSchema>

export function readConfig(): AppConfig {
  return configSchema.parse(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
}

/** Raw read for callers that must not throw on a config that has drifted out of schema. */
export function readConfigRaw(): unknown {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
}

export function writeConfig(next: unknown): AppConfig {
  const parsed = configSchema.parse(next)
  writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + '\n')
  return parsed
}
