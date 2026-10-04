// The origin guard: the server binds 127.0.0.1, but any page open in the browser can send it a "simple"
// cross-site POST. Only the app itself and the LinkedIn clipper extension may write.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXTENSION_ID, hostAllowed, originAllowed } from '../server/utils/origin.ts'

test('writes are allowed from the app, from the clipper, and from no browser at all', () => {
  assert.equal(originAllowed('POST', undefined), true, 'curl and server-side calls send no Origin')
  assert.equal(originAllowed('POST', 'http://127.0.0.1:3939'), true)
  assert.equal(originAllowed('PUT', 'http://localhost:3939'), true)
  assert.equal(originAllowed('POST', `chrome-extension://${EXTENSION_ID}`), true)
})

test('writes from anywhere else are refused', () => {
  assert.equal(originAllowed('POST', 'https://www.linkedin.com'), false, 'a LinkedIn page itself')
  assert.equal(originAllowed('POST', 'https://evil.example'), false)
  assert.equal(originAllowed('DELETE', 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh'), false, 'another extension')
  assert.equal(originAllowed('POST', 'null'), false, 'a sandboxed frame')
  assert.equal(originAllowed('PATCH', 'http://127.0.0.1:3940'), false, 'another local port')
})

test('EXTENSION_ID is the ID Chrome derives from the manifest key', async () => {
  // change one without the other and the clipper is locked out with a 403 on every click
  const { readFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const key = (JSON.parse(readFileSync('extension/manifest.json', 'utf8')) as { key: string }).key
  const id = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)))
  assert.equal(id, EXTENSION_ID)
})

test('reads are never guarded; every write is, /api or not', () => {
  // the Gmail OAuth callback is itself a cross-site GET, protected by its own state nonce
  assert.equal(originAllowed('GET', 'https://accounts.google.com'), true)
  assert.equal(originAllowed('GET', 'https://evil.example'), true)
  assert.equal(originAllowed('HEAD', 'https://evil.example'), true)
  // the daily task runs a backup and a Gmail sync: a write, wherever it lives
  assert.equal(originAllowed('POST', 'https://evil.example'), false)
})

test('only this machine\'s own host names are served — a DNS-rebinding page cannot read the API', () => {
  assert.equal(hostAllowed('127.0.0.1:3939'), true)
  assert.equal(hostAllowed('localhost:3939'), true)
  assert.equal(hostAllowed(undefined), true, 'no Host: not a browser')
  assert.equal(hostAllowed('attacker.example:3939'), false)
  assert.equal(hostAllowed('127.0.0.1.attacker.example:3939'), false)
})
