import { missingFields, readConfigLoose } from '../../utils/config'
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
  return {
    missing,
    ready: missing.length === 0,
    cv: config.cv,
    cvExists: cvExists(config.cv)
  }
})
