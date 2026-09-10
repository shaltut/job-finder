/** '3h' / '2d' as scraped, falling back to a relative form derived from the absolute timestamp. */
export function age(postedAge: string | null, postedAt: string | null): string {
  if (postedAge) return postedAge
  if (!postedAt) return '—'
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(postedAt)) / 60000))
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

/** Score 0-10 to a Nuxt UI colour. Ordering hint only, never a verdict. */
export function scoreColor(score: number | null): 'success' | 'warning' | 'neutral' {
  if (score === null) return 'neutral'
  if (score >= 8) return 'success'
  if (score >= 6) return 'warning'
  return 'neutral'
}
