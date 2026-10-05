import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { GapsResponse, GapTerm } from '../../shared/gaps'
import { cvPath, readConfigLoose } from '../utils/config'
import { cvExists } from '../utils/cv'
import { MASTER_CACHE, MASTER_CACHE_VERSION, pdfSha256, readCache } from '../utils/cv-master'
import { masterText } from '../utils/cv-tailor'
import { sqlite } from '../utils/db'
import { aggregateGaps, applicationCounts, requirementRows } from '../utils/gaps'

const query = z.object({ term: z.string().trim().min(1).max(200).optional() })

/**
 * The Gaps page. Read-only, and it never calls a model: "on your CV" is matched against the cached master
 * CV, and a CV uploaded since shows up as fewer applications analysed until the gaps job re-reads them.
 * A cache from an older MasterCv shape is ignored rather than spread — masterText would throw on it.
 *
 * The list goes out WITHOUT each term's posts, and `?term=` returns one term's posts when its row is
 * opened. Measured 2026-10-05: 3,030 terms carrying 10,733 quoted posts made a 6.4 MB response the browser
 * had to parse and render on every visit.
 */
export default defineEventHandler(async (event): Promise<GapsResponse | { posts: GapTerm['posts'] }> => {
  const { term } = await getValidatedQuery(event, query.parse)
  const config = readConfigLoose()
  const sha = config.cv && cvExists(config.cv) ? pdfSha256(readFileSync(cvPath(config))) : ''
  const cached = readCache(MASTER_CACHE)
  const cvText = cached?.version === MASTER_CACHE_VERSION ? masterText(cached.cv) : ''
  const terms = aggregateGaps(requirementRows(sqlite), cvText)
  if (term) return { posts: terms.find(t => t.term.toLowerCase() === term.toLowerCase())?.posts ?? [] }
  return { terms: terms.map(t => ({ ...t, posts: [] })), ...applicationCounts(sqlite, sha) }
})
