// Properties that must hold for the whole server, checked over the source rather than at runtime.
// Each one is a mistake that would be silent and expensive if it were ever reintroduced.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|js|vue)$/.test(name)) out.push(p)
  }
  return out
}

// shared/ holds the settings schema and EMPTY_SETTINGS, which are exactly the kind of place a real
// address would get seeded into. The identity scan below is worthless if it cannot see them.
const serverFiles = [...walk('server'), ...walk('shared')]
const read = (p: string) => readFileSync(p, 'utf8')

test('the server never sends mail: it only ever creates drafts', () => {
  // `gmail.compose` includes permission to send, so never-sending is a property of this code, not of the
  // credential. If a send call is ever added, this test is the thing that catches it.
  const forbidden = /\bmessages\.send\b|\bdrafts\/send\b|\bdrafts\.send\b|users\.messages\.send|\/send\b/
  const offenders = serverFiles.filter(f => forbidden.test(read(f)))
  assert.deepEqual(offenders, [], `these files look like they can send mail: ${offenders.join(', ')}`)
})

test('the drafter runs from a neutral directory, never the project root', () => {
  // `claude -p` loads the CLAUDE.md of its cwd. Running it in the project folder leaked the previous
  // owner's name into a drafter report; the identity in the appended prompt must be the only one it sees.
  const src = read('server/utils/drafter.ts')
  assert.match(src, /cwd: neutralCwd\(\)/, 'the drafter must spawn with cwd: neutralCwd()')
  assert.doesNotMatch(src, /spawn\(\s*'claude'[^)]*cwd:\s*process\.cwd\(\)/s, 'the drafter must not spawn in the project root')
})

test('the drafter is granted no usable tools', () => {
  const src = read('server/utils/drafter.ts')
  assert.match(src, /--strict-mcp-config/, 'MCP servers must be skipped')
  assert.match(src, /'--allowed-tools', 'NoToolsPermitted'/, 'the allow list must name no real tool')
  for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch']) {
    assert.ok(new RegExp(`'${tool}'`).test(src), `${tool} must be in the deny list`)
  }
})

test('the contacts upsert can never resurrect a \'final\' recruiter', () => {
  // two emails per address, ever — enforced by the database, not by prose
  const src = read('server/utils/drafts.ts')
  assert.match(src, /WHERE contacts\.stage <> 'final'/, 'the contacts upsert must carry WHERE stage <> \'final\'')
})

test('the schema keeps the lower-case email constraint', () => {
  assert.match(read('server/db/schema.ts'), /lower\(/, 'contacts.email must be constrained to lower case')
})

test('no server file hardcodes an identity: it all comes from the stored settings', () => {
  // retargeting this tool must stay data entry. A name or address in the source is how it stops being that.
  const offenders: string[] = []
  for (const f of serverFiles) {
    const src = read(f)
    // the drafter's comments explain the leak that motivated neutralCwd(), so strip comments first
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/@gmail\.com|@qhslab\.com|linkedin\.com\/in\//.test(code)) offenders.push(f)
  }
  assert.deepEqual(offenders, [], `these files hardcode contact details: ${offenders.join(', ')}`)
})

test('a skip can never downgrade a post an email already names', () => {
  // Found live: re-drafting a recruiter whose draft was pending rewrote the post's verdict from
  // 'drafted' to 'skipped', losing the `named in ...` prefix the follow-up query depends on.
  const src = readFileSync('server/utils/jobs.ts', 'utf8')
  const skipInsert = src.slice(src.indexOf('VALUES (?, \'skipped\''))
  assert.match(
    skipInsert.slice(0, 400),
    /WHERE applications\.verdict <> 'drafted'/,
    'the closed-recruiter skip must carry WHERE applications.verdict <> \'drafted\''
  )
})

test('the OAuth callback checks the state nonce BEFORE exchanging the code', () => {
  // Google's redirect into the callback is a cross-site GET that no Origin/Sec-Fetch guard can cover.
  // Without this, any page open in the browser could hand us its own code. Ported from upstream e8be7b6.
  const src = readFileSync('server/api/gmail/callback.get.ts', 'utf8')
  const stateAt = src.indexOf('consumeAuthState')
  const exchangeAt = src.indexOf('exchangeCode(')
  assert.ok(stateAt > 0, 'the callback must consume the state nonce')
  assert.ok(exchangeAt > stateAt, 'the state check must come before the code exchange')
  assert.match(src, /statusCode: 400/, 'a bad state must be a 400')
})

test('the state nonce is one-shot, so a replayed callback fails too', () => {
  const src = readFileSync('server/utils/gmail.ts', 'utf8')
  const fn = src.slice(src.indexOf('export function consumeAuthState'))
  assert.match(fn.slice(0, 300), /__jobfinderAuthState = null/, 'the nonce must be cleared on use')
})

test('the Gmail scopes cover the sweep as well as drafting', () => {
  const src = readFileSync('server/utils/gmail.ts', 'utf8')
  assert.match(src, /gmail\.compose/)
  // the sweep searches sent mail with q=, which the narrower gmail.metadata scope rejects
  assert.match(src, /gmail\.readonly/)
})

test('config.json is not read anywhere: the database is the only source of settings', () => {
  // It was git-tracked and therefore carried a real phone number and email address into the repo.
  // The one permitted mention is the one-time import in the migrate plugin, which carries the old
  // file across on first boot and then never touches it again.
  // comments may still name the file to explain the migration, so strip them first — as the
  // identity test above does — and look only at code
  const offenders = [...serverFiles, 'scraper/run.ts', 'scraper/lib.ts']
    .filter(f => f !== 'server/plugins/migrate.ts')
    .filter((f) => {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      return /config\.json/.test(code)
    })
  assert.deepEqual(offenders, [], `these files still read config.json: ${offenders.join(', ')}`)
})
