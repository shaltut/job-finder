/* global chrome */
// Adds a "+ Job Finder" button to each LinkedIn post. One click: expand "…more", read the card the way the
// scraper reads it (readCards in scraper/run.ts), and send it through the background worker to the app's
// Paste-a-post intake. See docs/superpowers/specs/2026-10-04-linkedin-clipper-design.md.
(() => {
  // lib.js runs first (manifest content_scripts order) and leaves these here
  const { authorOf, clippable, linkedInOnly, MORE_LABEL, postLinkOf, resultLabel } = globalThis.JobFinderClip
  const MARK = 'data-jf-clip'
  const PROFILE = 'a[href*="/in/"],a[href*="/company/"]'
  const TONE = { ok: '#0a7d3c', info: '#555', warn: '#9a6700', error: '#b42318' }

  // LinkedIn's class names are hashed, so cards are found by structure: a container whose children each
  // hold an author link, as the scraper does. Outermost such containers only — a feed card with its
  // comments open holds a comment list of that same shape, and that list must never win.
  function cards() {
    const main = document.querySelector('main')
    if (!main) return []
    const lists = []
    for (const e of main.querySelectorAll('div')) {
      let n = 0
      for (const c of e.children) if (c.querySelector(PROFILE)) n++
      if (n >= 2) lists.push({ e, n })
    }
    const outer = lists.filter(l => !lists.some(o => o !== l && o.e.contains(l.e)))
    const best = outer.sort((a, b) => b.n - a.n)[0]?.e
    return best ? [...best.children].filter(c => c.querySelector(PROFILE)) : []
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
    // read without the button in it — the stored text must be the card exactly as a scrape stores it
    btn.remove()
    const text = card.innerText.trim()
    const anchors = [...card.querySelectorAll('a[href]')]
    card.prepend(btn)
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
    btn.style.color = TONE[label.tone]
    btn.title = res?.body?.error || ''
    // a refusal can be retried (start the app, change Settings); success or a duplicate cannot
    btn.disabled = label.tone === 'ok' || label.tone === 'info'
  }

  function decorate() {
    if (!clippable(location.pathname)) return // LinkedIn is a single-page app: checked on every pass
    for (const card of cards()) {
      if (card.hasAttribute(MARK)) continue
      card.setAttribute(MARK, '')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = '+ Job Finder'
      btn.style.cssText = 'margin:6px 12px 0;padding:2px 10px;border:1px solid #0a66c2;border-radius:12px;'
        + 'background:#fff;color:#0a66c2;font:600 12px system-ui,sans-serif;cursor:pointer'
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // only a real click: a script on the page calling btn.click() must not spend OpenAI calls
        if (!e.isTrusted) return
        clip(card, btn)
      })
      card.prepend(btn)
    }
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
