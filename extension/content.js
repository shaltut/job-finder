/* global chrome */
// Adds a "+ Job Finder" button to each LinkedIn post. One click: expand "…more", read the card the way the
// scraper reads it (readCards in scraper/run.ts), and send it through the background worker to the app's
// Paste-a-post intake. See docs/superpowers/specs/2026-10-04-linkedin-clipper-design.md.
(() => {
  // lib.js runs first (manifest content_scripts order) and leaves these here
  const { authorOf, clippable, isDark, linkedInOnly, MORE_LABEL, postLinkOf, resultLabel } = globalThis.JobFinderClip
  const MARK = 'data-jf-clip'
  // two palettes: LinkedIn's own blue on its light card, its lighter blue and muted fills on the dark one
  const THEME = {
    light: { fg: '#0a66c2', bg: '#ffffff', border: '#0a66c2', tone: { ok: '#0a7d3c', info: '#5e5e5e', warn: '#9a6700', error: '#b42318' } },
    dark: { fg: '#71b7fb', bg: '#1b1f23', border: '#71b7fb', tone: { ok: '#5fd38a', info: '#b0b7bf', warn: '#f2c14e', error: '#ff8a80' } }
  }

  /** The palette for the card's real background: the first non-transparent one up the tree. */
  function themeOf(el) {
    for (let e = el; e; e = e.parentElement) {
      const dark = isDark(getComputedStyle(e).backgroundColor)
      if (dark !== null) return dark ? THEME.dark : THEME.light
    }
    return THEME.light
  }

  // One element per post. Measured on the live feed, 2026-10-04: each post is a role="listitem" whose
  // componentkey starts "update-card", and its innerText equals the card text the scraper stores. The
  // structural rule the scraper uses ("a container whose children each hold an author link") picked the
  // page's three layout columns instead on this layout. Fallback for search pages: the scraper's own
  // per-post token, an element id "expanded<token>" / "collapsed<token>".
  const POST = '[role="listitem"][componentkey^="update-card"]'
  const TOKEN = '[id^="expanded"],[id^="collapsed"]'
  function cards() {
    const main = document.querySelector('main')
    if (!main) return []
    const items = [...main.querySelectorAll(POST)]
    // on the feed the token element wraps the listitem, so either direction means "already counted"
    const loose = [...main.querySelectorAll(TOKEN)].filter(t => !t.closest(POST) && !t.querySelector(POST))
    // a lazy post renders empty first; it gets its button on a later pass, once it has text
    return [...items, ...loose].filter(c => c.innerText.trim().length > 0)
  }

  // "…more" can re-render the post; find it again by the attribute that identifies it
  function current(card) {
    const key = card.getAttribute('componentkey')
    if (key) return document.querySelector(`[componentkey="${CSS.escape(key)}"]`) || card
    const token = card.id.replace(/^(expanded|collapsed)/, '')
    return document.getElementById(`expanded${token}`) || document.getElementById(`collapsed${token}`) || card
  }

  const wait = ms => new Promise(r => setTimeout(r, ms))

  async function expand(card) {
    const more = [...card.querySelectorAll('button')].filter(b => MORE_LABEL.test(b.innerText || ''))
    if (!more.length) return
    const before = card.innerText.length
    for (const b of more) b.click()
    for (let i = 0; i < 15 && card.innerText.length <= before; i++) await wait(100)
  }

  async function send(post) {
    try {
      return await chrome.runtime.sendMessage({ type: 'clip', post })
    } catch {
      // "Extension context invalidated" after the extension is reloaded: this page's script is orphaned
      return { status: -1, body: { error: 'Extension was reloaded — refresh this page' } }
    }
  }

  async function clip(card, btn) {
    btn.disabled = true
    btn.textContent = 'Sending…'
    await expand(card)
    const now = current(card)
    if (now !== card) {
      // "…more" re-rendered the post: the button follows the new element
      placed.delete(card)
      placed.set(now, btn)
      now.setAttribute(MARK, '')
      card = now
    }
    // the button lives in its own layer, never in the card: the text is the card exactly as a scrape stores it
    const text = card.innerText.trim()
    const anchors = [...card.querySelectorAll('a[href]')]
    const author = authorOf(anchors.map(a => ({ href: a.href, text: a.innerText || '' })))
    const authorUrl = linkedInOnly(author?.url)
    const res = await send({
      text,
      author: (authorUrl && author?.name) || undefined,
      authorUrl,
      postUrl: linkedInOnly(postLinkOf(anchors.map(a => a.href)) || undefined)
    })
    const label = resultLabel(res?.status ?? 0, res?.body ?? {})
    btn.textContent = label.text
    const t = themeOf(card)
    btn.style.color = t.tone[label.tone]
    btn.style.borderColor = t.tone[label.tone]
    btn.title = res?.body?.error || ''
    // a refusal can be retried (start the app, change Settings); success or a duplicate cannot
    btn.disabled = label.tone === 'ok' || label.tone === 'info'
  }

  // The buttons sit in the empty gutter right of each card. Not inside the card's own tree: five of its
  // ancestors, <main> and <body> among them, are overflow:hidden and clip anything drawn outside the card
  // (measured live, 2026-10-04). A fixed layer is not clipped by them; each button follows its card.
  const layer = document.createElement('div')
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  document.documentElement.append(layer)
  const placed = new Map() // card -> its button
  const GUTTER = 150 // px of empty space needed right of the card; narrower windows get the button inside it

  function place() {
    for (const [card, btn] of placed) {
      if (!card.isConnected) {
        btn.remove()
        placed.delete(card)
        continue
      }
      const r = card.getBoundingClientRect()
      const visible = r.bottom > 40 && r.top < innerHeight && clippable(location.pathname)
      btn.style.display = visible ? '' : 'none'
      if (!visible) continue
      // beside the card's top, and kept beside the card while its top scrolls off — never past its bottom
      btn.style.top = `${Math.min(Math.max(r.top + 8, 8), r.bottom - 32)}px`
      btn.style.left = innerWidth - r.right >= GUTTER
        ? `${r.right + 12}px`
        : `${r.right - btn.offsetWidth - 96}px` // inside, left of LinkedIn's own "…" and "×"
    }
  }
  let frame = 0
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }
  }
  // capture: the feed scrolls an inner element, not the window
  addEventListener('scroll', schedule, { capture: true, passive: true })
  addEventListener('resize', schedule, { passive: true })

  function decorate() {
    if (!clippable(location.pathname)) return schedule() // LinkedIn is a single-page app: hide, don't decorate
    for (const card of cards()) {
      if (card.hasAttribute(MARK)) continue
      card.setAttribute(MARK, '')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = '+ Job Finder'
      const t = themeOf(card)
      btn.style.cssText = `position:absolute;pointer-events:auto;white-space:nowrap;padding:3px 12px;`
        + `border:1px solid ${t.border};border-radius:14px;background:${t.bg};color:${t.fg};`
        + 'font:600 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.35)'
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // only a real click: a script on the page calling btn.click() must not spend OpenAI calls
        if (!e.isTrusted) return
        // the map, not the closure: "…more" may have swapped the card element under this button
        const owner = [...placed].find(([, b]) => b === btn)?.[0] ?? card
        clip(owner, btn)
      })
      layer.append(btn)
      placed.set(card, btn)
    }
    schedule()
  }

  // throttled, and idle while the tab is hidden: the feed mutates constantly, and cards() walks every div
  let pending = false
  new MutationObserver(() => {
    if (pending || document.hidden) return
    pending = true
    setTimeout(() => {
      pending = false
      decorate()
    }, 600)
  }).observe(document.body, { childList: true, subtree: true })
  decorate()
})()
