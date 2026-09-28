import { z } from 'zod'
import { sqlite } from '../../utils/db'
import { setApplied } from '../../utils/ingest'
import { enqueue } from '../../utils/jobs'

const body = z.object({
  // one row's button, a bulk selection, and the Undo toast are all the same call
  keys: z.array(z.string().regex(/^[0-9a-f]{40}$/, 'key must be a sha1')).min(1).max(500),
  applied: z.boolean()
})

/**
 * Mark posts applied from the Posts view, or un-mark them. The sibling of dismiss.post.ts in every
 * respect — same validation, same raw handle, same symmetry that makes the Undo toast free — because
 * it writes the same kind of thing: the owner's own triage, on a post no draft could ever reach.
 */
export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)
  const updated = setApplied(sqlite, a.keys, a.applied)
  // an application made by hand is still an application: read it for the gap record
  if (a.applied && updated) enqueue('gaps', { keys: a.keys })
  return { updated }
})
