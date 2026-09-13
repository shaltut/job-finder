import { missingFields, missingForDrafting, readConfigLoose, settingsWarnings } from '../../utils/config'
import { cvExists } from '../../utils/cv'

/**
 * What Settings still needs before a scrape or a draft will start. Computed on the server because
 * one of the answers — whether the CV file is actually on disk — is not something the browser can
 * know, and because completeness then has exactly one definition rather than a copy in the page.
 */
export default defineEventHandler(() => {
  const config = readConfigLoose()
  const missing = missingFields(config)
  if (config.cv && !cvExists(config.cv)) missing.push(`cv: file not found at ${config.cv}`)
  // Two tiers, never merged: `missing`/`ready` keep meaning exactly what they meant before (what
  // stops a scrape), so the page's existing alert is unchanged, and the draft-only extras are listed
  // separately rather than repeated into it.
  const missingForDraft = missingForDrafting(config)
  return {
    missing,
    ready: missing.length === 0,
    missingForDraft,
    readyToDraft: missing.length === 0 && missingForDraft.length === 0,
    warnings: settingsWarnings(config),
    cv: config.cv,
    cvExists: cvExists(config.cv)
  }
})
