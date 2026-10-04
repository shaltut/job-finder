import { z } from 'zod'
import { sqlite } from '../../utils/db'
import { readConfig } from '../../utils/config'
import { enqueue } from '../../utils/jobs'
import { isLinkedInUrl, pasteGate } from '../../utils/paste'

const linkedIn = z.string().trim().max(500).refine(isLinkedInUrl, 'must be an https linkedin.com link')
const body = z.object({
  // a whole job post pasted from email or WhatsApp; the floor rejects an accidental empty submit
  text: z.string().trim().min(40, 'paste the whole post — this is too short to be one'),
  // sent by the LinkedIn clipper extension (extension/); a paste from the Posts view has none of them
  author: z.string().trim().max(200).optional(),
  authorUrl: linkedIn.optional(),
  postUrl: linkedIn.optional()
})

/**
 * Admit a job post that never passed through LinkedIn. The gate runs here rather than on the lane
 * because it is pure regex over a string: the owner finds out immediately whether the post was taken,
 * and only the OpenAI score is queued. The strict readConfig() is deliberate — scoring needs the CV,
 * the scope and the titles, so accepting a paste the pipeline cannot score would queue certain failure.
 */
export default defineEventHandler(async (event) => {
  const a = await readValidatedBody(event, body.parse)

  let config
  try {
    config = readConfig()
  } catch (e) {
    setResponseStatus(event, 422)
    return { error: (e as Error).message }
  }

  const prov = { author: a.author, authorUrl: a.authorUrl, postUrl: a.postUrl }
  const gate = pasteGate(a.text, config, prov)
  if (!gate.ok) {
    setResponseStatus(event, 422)
    return {
      error: 'no contact route in this post',
      found: { emails: gate.found.emails.length, links: gate.found.links.length, phones: gate.found.phones.length },
      enabled: gate.enabled
    }
  }

  if (sqlite.prepare('SELECT 1 FROM posts WHERE key = ?').get(gate.key)) {
    return { duplicate: true, key: gate.key }
  }

  const item = enqueue('paste', { text: a.text, ...prov })
  setResponseStatus(event, item ? 202 : 200)
  // a repeat paste of the same text already queued, or still being scored, is a no-op, not a second job
  return { queued: !!item, key: gate.key, note: item ? undefined : 'already queued or running' }
})
