// The clipper's pure parts. A classic script, not a module: the manifest loads it before content.js and it
// leaves its functions on globalThis.JobFinderClip — content.js reads them there, and test/extension.test.ts
// imports this file for the same side effect. (A dynamic import() of a web-accessible copy was tried first,
// and no button ever appeared on a real feed, 2026-10-04 — the riskiest line, so removed.) No DOM, no chrome.*.

/**
 * The post's author, by the scraper's own rule (readCards in scraper/run.ts): the most repeated
 * /in/ or /company/ link, query string dropped, ties in DOM order. A repost links the resharer twice and
 * the author three times. It must match the scraper byte for byte — the server keys a clipped post as
 * dedupeKey(authorUrl, text), so a different URL would store a post the scraper already has.
 * @param {{ href: string, text: string }[]} links every anchor in the card
 * @returns {{ url: string, name: string } | null}
 */
function authorOf(links) {
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
 * Pages where the cards() heuristic finds posts: the feed and content search — the two the scraper reads.
 * Anywhere else the busiest list of profile links is something else (a thread, a comment list on a single
 * post, people results), and a button there would clip a comment or a person.
 * @param {string} pathname
 */
const clippable = pathname => /^\/feed\/?$/.test(pathname) || pathname.startsWith('/search/results/content')

/**
 * An author link the server will accept (https linkedin.com), or none — then the clip degrades to a plain
 * paste instead of a 400.
 * @param {string | undefined} url
 */
function linkedInOnly(url) {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'linkedin.com' || u.hostname.endsWith('.linkedin.com')) ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * The "…more" expander, by the scraper's own pattern (MORE_LABEL in scraper/lib.ts). It follows the UI
 * language, not the post's, so an English post still carries the Arabic label on an Arabic account.
 */
const MORE_LABEL = /…\s*(?:more|المزيد)\s*$/

/**
 * The post's own permalink, when the card exposes one — often it does not (LinkedIn strips URNs from
 * much of the page), and then there is none rather than a guess.
 * @param {string[]} hrefs
 */
function postLinkOf(hrefs) {
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
 * Whether a computed background colour is dark — LinkedIn's dark mode is its own setting, not the OS's,
 * so the button reads the card it sits on. null for a transparent or unreadable colour: look further up.
 * @param {string} css e.g. "rgb(27, 31, 35)"
 * @returns {boolean | null}
 */
function isDark(css) {
  const open = css.indexOf('(')
  const close = css.indexOf(')')
  if (!css.startsWith('rgb') || open < 0 || close < open) return null
  const [r, g, b, a = 1] = css.slice(open + 1, close).split(',').map(Number)
  if ([r, g, b, a].some(Number.isNaN) || a === 0) return null
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/**
 * What the button says after a click, from the paste endpoint's reply. Status 0 is a network failure:
 * the app is not running (or not on 127.0.0.1:3939).
 * @returns {{ text: string, tone: 'ok' | 'info' | 'warn' | 'error' }}
 */
function resultLabel(status, body) {
  if (status === 0) return { text: 'Job Finder not running', tone: 'error' }
  if (status === 403) return { text: 'Job Finder refused this extension', tone: 'error' }
  if (body?.duplicate) return { text: 'Already have it', tone: 'info' }
  if (status === 202 || body?.queued) return { text: '✓ Added', tone: 'ok' }
  if (status === 200 && body?.queued === false) return { text: 'Already queued', tone: 'info' }
  if (status === 422 && body?.enabled) return { text: `No contact route (${body.enabled.join(', ')} only)`, tone: 'warn' }
  return { text: String(body?.error || body?.message || `Error ${status}`).slice(0, 80), tone: 'error' }
}

globalThis.JobFinderClip = { authorOf, clippable, isDark, linkedInOnly, MORE_LABEL, postLinkOf, resultLabel }
