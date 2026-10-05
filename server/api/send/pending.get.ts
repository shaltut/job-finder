import { sqlite } from '../../utils/db'

/** How many of the app's drafts the sender has not yet sent or set aside — the Run view's button label. */
export default defineEventHandler(() => {
  const r = sqlite.prepare(`SELECT
      sum(sent_at IS NULL AND outcome IS NULL) AS pending,
      sum(sent_at IS NOT NULL) AS sent,
      sum(outcome IS NOT NULL AND outcome <> 'gone') AS held
    FROM app_drafts`).get() as { pending: number | null, sent: number | null, held: number | null }
  return { pending: r.pending ?? 0, sent: r.sent ?? 0, held: r.held ?? 0 }
})
