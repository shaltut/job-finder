/* global chrome */
// Adds a "+ Job Finder" button to each LinkedIn post. One click: expand "…more", read the card the way the
// scraper reads it (readCards in scraper/run.ts), and send it through the background worker to the app's
// Paste-a-post intake. See docs/superpowers/specs/2026-10-04-linkedin-clipper-design.md.
(async () => {
  const { authorOf, MORE_LABEL, postLinkOf, resultLabel } = await import(chrome.runtime.getURL('lib.js'))
  const MARK = 'data-jf-clip'
  const PROFILE = 'a[href*="/in/"],a[href*="/company/"]'
  const TONE = { ok: '#0a7d3c', info: '#555', warn: '#9a6700', error: '#b42318' }

  // LinkedIn's class names are hashed, so cards are found by structure: the container whose children each
  // hold an author link, as the scraper does. Re-run on DOM changes — the feed renders as you scroll.
  function cards() {
    const main = document.querySelector('main')
    if (!main) return []
    let best = null
    let bestN = 1
    for (const e of main.querySelectorAll('div')) {
      let n = 0
      for (const c of e.children) if (c.querySelector(PROFILE)) n++
      if (n > bestN) {
        best = e
        bestN = n
      }
    }
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

  async function clip(card, btn) {
    btn.disabled = true
    btn.textContent = 'Sending…'
    await expand(card)
    const anchors = [...card.querySelectorAll('a[href]')]
    const author = authorOf(anchors.map(a => ({ href: a.href, text: a.innerText || '' })))
    const post = {
      text: card.innerText.replace(btn.innerText, '').trim(),
      author: author?.name || undefined,
      authorUrl: author?.url,
      postUrl: postLinkOf(anchors.map(a => a.href)) || undefined
    }
    const res = await chrome.runtime.sendMessage({ type: 'clip', post }).catch(() => ({ status: 0, body: {} }))
    const label = resultLabel(res.status, res.body)
    btn.textContent = label.text
    btn.style.color = TONE[label.tone]
    btn.title = res.body?.error || ''
    // a refusal can be retried (start the app, change Settings); success or a duplicate cannot
    btn.disabled = label.tone === 'ok' || label.tone === 'info'
  }

  function decorate() {
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
        clip(card, btn)
      })
      card.prepend(btn)
    }
  }

  // throttled: the feed mutates constantly, and cards() walks every div under <main>
  let pending = false
  new MutationObserver(() => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      decorate()
    }, 600)
  }).observe(document.body, { childList: true, subtree: true })
  decorate()
})()
