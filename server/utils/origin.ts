// Who may write to this server. It binds 127.0.0.1, but any page open in the browser can still send it a
// "simple" cross-site POST (text/plain, no preflight), and readBody parses JSON whatever the content type.
// So every write must come from the app itself, from the LinkedIn clipper extension, or from outside a
// browser altogether (curl sends no Origin). Reads stay open: the Gmail OAuth callback is a cross-site GET
// with its own state nonce. Pure, so test/origin.test.ts can reach it; server/middleware/origin.ts applies it.
// See docs/superpowers/specs/2026-10-04-linkedin-clipper-design.md.

/**
 * The clipper's extension ID, the same on every machine: Chrome derives it from the public `key` in
 * extension/manifest.json (sha256 of the key, first 32 hex digits mapped 0-f -> a-p). Change the key and
 * this must change with it.
 */
export const EXTENSION_ID = 'pdoeglcbbgfjnonkfjpdgbeonopkoipo'

const APP_ORIGINS = new Set(['http://127.0.0.1:3939', 'http://localhost:3939', `chrome-extension://${EXTENSION_ID}`])
const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function originAllowed(method: string, origin: string | undefined): boolean {
  if (READS.has(method.toUpperCase())) return true
  return origin === undefined || APP_ORIGINS.has(origin)
}
