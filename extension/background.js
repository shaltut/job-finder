/* global chrome */
// Sends a clipped post to the local Job Finder. Here rather than in the content script: a page on
// linkedin.com may not call 127.0.0.1 (CORS and Chrome's private-network rules), while this worker holds
// host permission for it. The server's origin guard admits this extension by its pinned ID.
const ENDPOINT = 'http://127.0.0.1:3939/api/posts/paste'

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'clip') return false
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(msg.post)
  })
    .then(async r => reply({ status: r.status, body: await r.json().catch(() => ({})) }))
    .catch(() => reply({ status: 0, body: {} })) // not running, or not on this port
  return true // reply arrives asynchronously
})
