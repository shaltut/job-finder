// The clipper's pure parts, imported by content.js (through chrome.runtime.getURL) and by
// test/extension.test.ts. No DOM, no chrome.* — plain data in, plain data out.

/**
 * The post's author, by the scraper's own rule (readCards in scraper/run.ts): the most repeated
 * /in/ or /company/ link, query string dropped, ties in DOM order. A repost links the resharer twice and
 * the author three times. It must match the scraper byte for byte — the server keys a clipped post as
 * dedupeKey(authorUrl, text), so a different URL would store a post the scraper already has.
 * @param {{ href: string, text: string }[]} links every anchor in the card
 * @returns {{ url: string, name: string } | null}
 */
export function authorOf(links) {
  const profiles = links
    .filter(l => l.href.includes('/in/') || l.href.includes('/company/'))
    .map(l => ({ href: l.href.split('?')[0], text: (l.text || '').trim().split('\n')[0] || '' }))
  if (!profiles.length) return null
  const seen = new Map()
  for (const l of profiles) seen.set(l.href, (seen.get(l.href) || 0) + 1)
  const url = [...seen].sort((a, b) => b[1] - a[1])[0][0]
  return { url, name: profiles.find(l => l.href === url && l.text)?.text || '' }
}

/**
 * The "…more" expander, by the scraper's own pattern (MORE_LABEL in scraper/lib.ts). It follows the UI
 * language, not the post's, so an English post still carries the Arabic label on an Arabic account.
 */
export const MORE_LABEL = /…\s*(?:more|المزيد)\s*$/

/**
 * The post's own permalink, when the card exposes one — often it does not (LinkedIn strips URNs from
 * much of the page), and then there is none rather than a guess.
 * @param {string[]} hrefs
 */
export function postLinkOf(hrefs) {
  for (const h of hrefs) {
    let u
    try {
      u = new URL(h)
    } catch {
      continue
    }
    if (!u.hostname.endsWith('linkedin.com')) continue
    if (u.pathname.startsWith('/feed/update/urn:li:') || u.pathname.startsWith('/posts/')) return u.origin + u.pathname
  }
  return null
}

/**
 * What the button says after a click, from the paste endpoint's reply. Status 0 is a network failure:
 * the app is not running (or not on 127.0.0.1:3939).
 * @returns {{ text: string, tone: 'ok' | 'info' | 'warn' | 'error' }}
 */
export function resultLabel(status, body) {
  if (status === 0) return { text: 'Job Finder not running', tone: 'error' }
  if (status === 403) return { text: 'Job Finder refused this extension', tone: 'error' }
  if (body?.duplicate) return { text: 'Already have it', tone: 'info' }
  if (status === 202 || body?.queued) return { text: '✓ Added', tone: 'ok' }
  if (status === 200 && body?.queued === false) return { text: 'Already queued', tone: 'info' }
  if (status === 422 && body?.enabled) return { text: `No contact route (${body.enabled.join(', ')} only)`, tone: 'warn' }
  return { text: String(body?.error || body?.message || `Error ${status}`).slice(0, 80), tone: 'error' }
}
