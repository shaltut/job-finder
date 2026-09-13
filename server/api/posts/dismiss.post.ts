import { z } from 'zod'
import { sqlite } from '../../utils/db'
import { setDismissed } from '../../utils/ingest'

const body = z.object({
  // one row's X button, a bulk selection, and the Undo toast are all the same call
  keys: z.array(z.string().regex(/^[0-9a-f]{40}$/, 'key must be a sha1')).min(1).max(500),
  dismissed: z.boolean()
})

/**
 * Dismiss posts from the Posts view, or restore them. The first endpoint here that writes a post row:
 * it goes through the raw handle server/utils/db.ts already owns, because the Nitro server is the sole
 * writer of the database and openWritableDb() is the job runners' separate connection.
 */
export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)
  return { updated: setDismissed(sqlite, a.keys, a.dismissed) }
})
