import { ZodError } from 'zod'
import { flagInputs } from '../../shared/settings'
import { readConfigLoose, writeConfig } from '../utils/config'
import { enqueue } from '../utils/jobs'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    // Decided here, against what was STORED, not in the page against its own load-time copy: a save from a
    // stale tab writes old flag inputs back while that tab sees no change, and the posts then keep flags
    // computed for settings that are no longer stored — the 2026-09-25 stale-flag bug by another door.
    const before = flagInputs(readConfigLoose())
    const saved = writeConfig(body)
    if (flagInputs(saved) !== before) enqueue('reflag')
    return saved
  } catch (e) {
    if (e instanceof ZodError) {
      // one readable line per bad field, rather than a wall of Zod internals
      const message = e.issues.map(i => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')
      throw createError({ statusCode: 400, message })
    }
    throw e
  }
})
