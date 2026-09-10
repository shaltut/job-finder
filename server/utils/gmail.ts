// Gmail over REST. The server owns every Gmail call; the drafter model never touches one.
//
// THIS MODULE NEVER SENDS. `gmail.compose` includes permission to send, so never-sending is a property of
// this code rather than of the credential — test/invariants.test.ts fails if a send call appears anywhere
// under server/. Drafts only.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const OAUTH_FILE = resolve(process.cwd(), 'google-oauth.json')
const TOKEN_FILE = resolve(process.cwd(), 'gmail-token.json')

/**
 * `gmail.readonly` alongside `gmail.compose`: the stage sweep searches sent mail with `q=`, which the
 * narrower `gmail.metadata` scope rejects outright. `userinfo.email` tells us which account was connected.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ')

export const REDIRECT = process.env.JOBFINDER_REDIRECT || 'http://localhost:3939/api/gmail/callback'

interface OAuthClient { client_id: string, client_secret: string, auth_uri?: string, token_uri?: string }
interface Token {
  refresh_token: string
  access_token: string
  expires_at: number
  email: string | null
}

export const oauthClient = (): OAuthClient | null => {
  if (!existsSync(OAUTH_FILE)) return null
  const j = JSON.parse(readFileSync(OAUTH_FILE, 'utf8'))
  return j.installed || j.web || null
}

const readToken = (): Token | null => {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    return null
  }
}
const writeToken = (t: Token) => writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 })

/**
 * The one-shot CSRF nonce, on globalThis so a Nitro dev hot-reload between pressing Connect and Google
 * redirecting back does not invalidate the callback.
 */
const g = globalThis as typeof globalThis & { __jobfinderAuthState?: string | null }

/**
 * Google's redirect into the callback is itself a cross-site GET, so an Origin / Sec-Fetch-Site guard has to
 * exempt GETs and cannot protect it. Without this nonce any page open in the browser could hand the server
 * its own authorization code and have the drafts written into its mailbox. Ported from upstream e8be7b6.
 */
export function authUrl(): string {
  const c = oauthClient()
  if (!c) {
    throw createError({
      statusCode: 409,
      message: 'google-oauth.json missing: download the OAuth Desktop client JSON from Google Cloud Console into the project folder'
    })
  }
  const u = new URL(c.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth')
  g.__jobfinderAuthState = randomUUID()
  u.search = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: g.__jobfinderAuthState
  }).toString()
  return u.toString()
}

/** True only for the exact nonce this server minted, and only once. */
export function consumeAuthState(state: string | undefined): boolean {
  const expected = g.__jobfinderAuthState
  g.__jobfinderAuthState = null // one shot: a replayed callback fails too
  return !!expected && !!state && state === expected
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, string & number>> {
  const c = oauthClient()
  if (!c) throw createError({ statusCode: 409, message: 'google-oauth.json missing' })
  const r = await fetch(c.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...params })
  })
  const j = await r.json()
  if (!r.ok) throw createError({ statusCode: 502, message: `oauth: ${j.error_description || j.error}` })
  return j
}

const userinfoEmail = (accessToken: string) =>
  fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })
    .then(r => r.json()).then(j => (j.email as string) || null).catch(() => null)

export async function exchangeCode(code: string): Promise<Token> {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT })
  const token: Token = {
    refresh_token: String(t.refresh_token),
    access_token: String(t.access_token),
    expires_at: Date.now() + Number(t.expires_in) * 1000,
    email: await userinfoEmail(String(t.access_token))
  }
  writeToken(token)
  return token
}

async function accessToken(): Promise<Token> {
  const t = readToken()
  if (!t?.refresh_token) throw createError({ statusCode: 409, message: 'gmail not connected' })
  if (t.expires_at - Date.now() > 60_000) return t
  const n = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' })
  const fresh: Token = { ...t, access_token: String(n.access_token), expires_at: Date.now() + Number(n.expires_in) * 1000 }
  fresh.email ||= await userinfoEmail(fresh.access_token)
  writeToken(fresh)
  return fresh
}

export async function gmail<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const t = await accessToken()
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { 'authorization': `Bearer ${t.access_token}`, 'content-type': 'application/json' }
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    throw createError({ statusCode: r.status, message: `gmail ${path.split('?')[0]}: ${j.error?.message || r.status}` })
  }
  return j as T
}

export interface GmailStatus {
  configured: boolean
  authorized: boolean
  email: string | null
  expected: string | null
  mismatch: boolean
  redirect: string
}

/**
 * `expected` is the address in config.json. The stage sweep decides "already contacted?" by matching the
 * sender on sent mail, so connecting the wrong account would silently make every sent application look
 * unsent. We report the mismatch rather than hardcoding the address.
 */
export function gmailStatus(expectedEmail: string | null = null): GmailStatus {
  const t = readToken()
  const email = t?.email ?? null
  return {
    configured: !!oauthClient(),
    authorized: !!t?.refresh_token,
    email,
    expected: expectedEmail,
    mismatch: !!(email && expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase()),
    redirect: REDIRECT
  }
}

export function disconnect() {
  if (existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, JSON.stringify({}, null, 2), { mode: 0o600 })
}

// ---------------- MIME ----------------

const b64lines = (buf: Buffer | string) => Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n')
// a non-ASCII subject must be encoded or Gmail mangles it
const encHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)

export interface MimeInput {
  to: string
  subject?: string
  inReplyTo?: string
  references?: string
  text: string
  html?: string
}

/** multipart/mixed [ multipart/alternative [text, html], application/pdf ]. */
export function buildMime(m: MimeInput, pdfName?: string, pdf?: Buffer): string {
  const A = `mixed${Date.now()}`
  const B = `alt${Date.now()}`
  const head = [
    `To: ${m.to}`,
    m.subject ? `Subject: ${encHeader(m.subject)}` : '',
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : '',
    m.references ? `References: ${m.references}` : '',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${A}"`
  ].filter(Boolean)

  const body = [
    `--${A}`,
    `Content-Type: multipart/alternative; boundary="${B}"`,
    '',
    `--${B}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(m.text),
    ...(m.html ? [`--${B}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(m.html)] : []),
    `--${B}--`,
    ...(pdf && pdfName
      ? [`--${A}`,
          `Content-Type: application/pdf; name="${pdfName}"`,
          `Content-Disposition: attachment; filename="${pdfName}"`,
          'Content-Transfer-Encoding: base64', '', b64lines(pdf)]
      : []),
    `--${A}--`,
    ''
  ]
  return [...head, '', ...body].join('\r\n')
}

/**
 * Gmail rewrites bare URLs in a plain-text body into google.com/url?q= redirects — two applications went out
 * that way on the original. The HTML part carries real anchors, so the links survive.
 */
export function renderHtml(text: string, signature: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const link = (s: string) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}">${u.replace(/^https?:\/\//, '')}</a>`)
  const block = (s: string) => s.split('\n').map(link).join('<br>')
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55">${block(text)}<br><br>${block(signature)}</div>`
}

export interface CreatedDraft { id: string, threadId: string | null, attachedBytes: number | null }

/**
 * Creates a Gmail draft with the CV attached in the same call. The original had to re-open every draft
 * afterwards to attach the PDF, because the MCP tool corrupted base64 passed through the model; here the
 * bytes are read from disk by the server and never touch a model.
 */
export async function createDraft(
  m: MimeInput,
  cvPath: string | null,
  threadId?: string
): Promise<CreatedDraft> {
  let pdf: Buffer | undefined
  let name: string | undefined
  if (cvPath && existsSync(cvPath)) {
    pdf = readFileSync(cvPath)
    name = basename(cvPath)
  }
  const raw = Buffer.from(buildMime(m, name, pdf)).toString('base64url')
  const created = await gmail<{ id: string, message?: { id: string, threadId?: string } }>('drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } })
  })

  // verify the attachment survived rather than assuming it did
  let attachedBytes: number | null = null
  if (name) {
    const full = await gmail<{ message: { payload: unknown } }>(`drafts/${created.id}?format=full`)
    attachedBytes = findAttachment(full.message.payload, name)
  }
  return { id: created.id, threadId: created.message?.threadId ?? null, attachedBytes }
}

interface Part { filename?: string, mimeType?: string, body?: { size?: number }, parts?: Part[] }
export function findAttachment(payload: unknown, name: string): number | null {
  const walk = (p: Part): number | null => {
    if (p.filename === name && p.body?.size) return p.body.size
    for (const c of p.parts ?? []) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  return walk(payload as Part)
}
