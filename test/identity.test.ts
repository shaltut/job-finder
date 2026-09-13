// Nothing in this repository may carry the identity of whoever happens to be running it.
//
// The old version of this check lived in invariants.test.ts and scanned server/ + shared/ for three
// literal patterns: a consumer mail domain, a previous owner's company domain, and a LinkedIn path.
// It could not have caught the bug that motivated this file — a subject-line template in the
// drafter's prompt that spelled out one person's name, so every install emailed recruiters under it
// whatever Settings said. A bare name matches none of those patterns. And naming a real company
// domain in the guard made the guard against hardcoded identities hardcode one.
//
// Two checks replace it. The first derives its needles from the STORED settings, so it works for
// whoever owns this install and never names anybody in source. The second looks for the SHAPE of
// contact details, so it catches a stranger's address as well as your own.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { readSettingsRawFrom } from '../shared/settings.ts'

const TEXT = /\.(ts|js|mjs|vue|md|json|yml|yaml|css|html)$/

/**
 * Everything that WOULD be in the repository if you committed right now: tracked files plus
 * untracked ones git is not ignoring. `--cached` alone would miss a new file that has not been
 * `git add`ed yet, which is exactly when a leak is easiest to introduce and cheapest to fix.
 *
 * Ignored files are deliberately out of scope: `gmail-token.json` holds the connected address and
 * `data/` holds the CV, but neither is ever shared, and flagging them would only teach people to
 * ignore this test.
 */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\0')
    .filter(f => f && TEXT.test(f) && f !== 'package-lock.json' && existsSync(f))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|js|vue)$/.test(name)) out.push(p)
  }
  return out
}

const read = (p: string) => readFileSync(p, 'utf8')
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function readProfile(dbPath: string): Record<string, string> | undefined {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = readSettingsRawFrom(db) as { profile?: Record<string, string> } | undefined
    db.close()
    return row?.profile ?? {}
  } catch {
    return undefined // no database, or it predates the settings table: nothing to leak yet
  }
}

/**
 * Needles built from the settings row rather than written down here. On a fresh clone the row is
 * empty and this returns nothing, so the test skips instead of failing — which is correct: there is
 * no identity to leak yet.
 */
function ownerNeedles(): { label: string, re: RegExp }[] {
  const dbPath = process.env.JOBFINDER_DB || 'data/jobfinder.db'
  if (process.env.JOBFINDER_SKIP_IDENTITY_SCAN || !existsSync(dbPath)) return []
  const profile = readProfile(dbPath)
  if (!profile) return []

  const out: { label: string, re: RegExp }[] = []
  const lit = (label: string, v: string | undefined, min = 4) => {
    const s = (v ?? '').trim()
    if (s.length >= min) out.push({ label, re: new RegExp(`\\b${escapeRe(s)}\\b`, 'i') })
  }
  lit('name', profile.name)
  // 5+ characters per token: a short given name is too easily an ordinary English word
  for (const tok of (profile.name ?? '').split(/\s+/)) lit('name token', tok, 5)
  lit('email', profile.email)
  lit('email local part', (profile.email ?? '').split('@')[0])
  for (const key of ['linkedin', 'github'] as const) {
    const slug = (profile[key] ?? '').replace(/\/+$/, '').split('/').pop()
    lit(`${key} handle`, slug, 4)
  }
  // digits only, so a reformatted number is still caught
  const digits = (profile.phone ?? '').replace(/\D/g, '').slice(-9)
  if (digits.length === 9) out.push({ label: 'phone', re: new RegExp(digits.split('').join('[\\s().+-]*')) })
  return out
}

test('no file in this repository carries the identity of whoever runs it', () => {
  const needles = ownerNeedles()
  if (!needles.length) return // fresh clone, or the scan was skipped deliberately

  const offenders: string[] = []
  for (const f of trackedFiles()) {
    const src = read(f)
    for (const { label, re } of needles) {
      if (re.test(src)) offenders.push(`${f} (${label})`)
    }
  }
  assert.deepEqual(
    offenders, [],
    'these files name the owner of this install; identity belongs in the settings row, not in source.\n'
    + 'If one is a false positive (a name token that is also an ordinary word), set '
    + 'JOBFINDER_SKIP_IDENTITY_SCAN=1 and say why.\n' + offenders.join('\n')
  )
})

test('no source file carries the SHAPE of a contact detail, whosever it is', () => {
  // Replaces the three-literal scan, which missed @outlook.com and every phone number ever written.
  // test/ is deliberately outside the surface: its fixtures carry deliberately fake details, and a
  // fixture that looks real is exactly how you tell it is a fixture.
  const SHAPES: [string, RegExp][] = [
    ['an email address', /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
    ['a phone number', /\+\d[\d\s().-]{7,}\d/],
    ['a LinkedIn profile', /linkedin\.com\/in\//i],
    ['a GitHub profile', /github\.com\/[A-Za-z0-9-]+/i]
  ]
  const surface = [...walk('server'), ...walk('shared'), ...walk('scraper'), ...walk('app')]
  const offenders: string[] = []
  for (const f of surface) {
    const code = stripComments(read(f))
    for (const [what, re] of SHAPES) if (re.test(code)) offenders.push(`${f} contains ${what}`)
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('the drafter procedure is procedure: it states no fact about any person', () => {
  const proc = read('server/prompts/drafter-procedure.md')
  assert.doesNotMatch(proc, /^---\n/, 'no skill frontmatter: this is server data, not an interactive skill')
  // person-flavoured prose almost always arrives with a pronoun attached, which makes this the
  // cheapest high-value check in the file
  assert.doesNotMatch(proc, /\b(he|him|his|she|her|hers)\b/i, 'the procedure must not gender the candidate')
  assert.doesNotMatch(proc, /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
  assert.doesNotMatch(proc, /\+\d[\d\s().-]{7,}\d/)
  // and it must actually defer to what is injected, or it is person-free only by accident
  for (const ref of [
    'injected Evidence section', 'injected Gaps', 'injected seniority floor',
    'injected field of work', 'injected constraints', 'injected name'
  ]) {
    assert.ok(proc.includes(ref), `the procedure must refer to the ${ref}`)
  }
})
