/** '28 Sep' in the viewer's locale; the full timestamp belongs in a tooltip. */
export const fmtDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'

/** Score 0-10 to a Nuxt UI colour. Ordering hint only, never a verdict. */
export function scoreColor(score: number | null): 'success' | 'warning' | 'neutral' {
  if (score === null) return 'neutral'
  if (score >= 8) return 'success'
  if (score >= 6) return 'warning'
  return 'neutral'
}
