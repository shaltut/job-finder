import { z } from 'zod'
import { patchConfig, readConfigLoose } from '../../utils/config'
import { enqueue } from '../../utils/jobs'

/**
 * Append one entry to the exclude list, from the Posts view rather than the Settings form.
 *
 * A dedicated endpoint rather than a PUT /api/config from the Posts page: that would mean shipping the
 * whole settings object back from a page that never loaded it to edit, which is how the CV path once
 * got silently overwritten. Here the read and the write happen server-side, a field apart.
 *
 * Deduping is left to parseSettings(), which folds case for the whole list — the match is
 * case-insensitive, so `micro1.ai` and `Micro1.AI` are one rule however they arrive.
 */
const body = z.object({
  // the same bounds as settingsSchema.excludes, so a bad needle fails here with a readable message
  // instead of inside parseSettings, where the error is a field path the dialog cannot render
  needle: z.string().trim().min(2).max(80)
})

export default defineEventHandler(async (event) => {
  const { needle } = await readValidatedBody(event, body.parse)
  const excludes = [...readConfigLoose().excludes, needle]
  const saved = patchConfig({ excludes })
  enqueue('reflag') // the list changed by definition; server-side for the reason config.put.ts gives
  return { excludes: saved.excludes }
})
