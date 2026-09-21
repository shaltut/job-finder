import { readFileSync } from 'node:fs'
import type { GapsResponse } from '../../shared/gaps'
import { cvPath, readConfigLoose } from '../utils/config'
import { cvExists } from '../utils/cv'
import { MASTER_CACHE, MASTER_CACHE_VERSION, pdfSha256, readCache } from '../utils/cv-master'
import { masterText } from '../utils/cv-tailor'
import { sqlite } from '../utils/db'
import { aggregateGaps, applicationCounts, requirementRows } from '../utils/gaps'

/**
 * The Gaps page. Read-only, and it never calls a model: "on your CV" is matched against the cached master
 * CV, and a CV uploaded since shows up as fewer applications analysed until the gaps job re-reads them.
 * A cache from an older MasterCv shape is ignored rather than spread — masterText would throw on it.
 */
export default defineEventHandler((): GapsResponse => {
  const config = readConfigLoose()
  const sha = config.cv && cvExists(config.cv) ? pdfSha256(readFileSync(cvPath(config))) : ''
  const cached = readCache(MASTER_CACHE)
  const cvText = cached?.version === MASTER_CACHE_VERSION ? masterText(cached.cv) : ''
  return { terms: aggregateGaps(requirementRows(sqlite), cvText), ...applicationCounts(sqlite, sha) }
})
