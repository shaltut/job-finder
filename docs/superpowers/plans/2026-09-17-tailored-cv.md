# Tailored CV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a CV tailored to each application — reordered and reworded in the post's own terms, fact-checked in code — instead of the one uploaded PDF, falling back to that PDF on any failure.

**Architecture:** The uploaded PDF is extracted once into a structured master CV, cached against the PDF's hash. The existing `claude -p` drafter returns a `cv` block beside the email; a pure checker (`tailoredCv`) enforces seven rules against the master; a lazily launched headless Chrome prints the result; `contacts.cv_path` records what each recruiter received so the follow-up reuses it.

**Tech Stack:** Nuxt 4 / Nitro, TypeScript on Node 22 native type stripping, Zod, better-sqlite3 + Drizzle, OpenAI Responses API, `playwright-core` (headless, `channel: 'chrome'`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-17-tailored-cv-design.md` — read it first; this plan argues from it.

## Global Constraints

- **No new dependencies.** Use only what is installed: `zod`, `openai`, `better-sqlite3`, `drizzle-orm`, `playwright-core`.
- **New server modules import siblings with an explicit `.ts` extension** (`from './drafter.ts'`), as `server/utils/config.ts` already does. An extensionless *value* import makes a module unloadable by `node --test`. Type-only imports (`import type`) are erased and may stay extensionless.
- **No identity literals.** Never write a name, email address, phone number, or LinkedIn/GitHub URL under `server/`, `shared/`, `scraper/` or `app/` — `test/identity.test.ts` fails the build. Test fixtures use `Test Person` and `test@example.com`.
- **Off by default:** `tailorCv: false` in `EMPTY_SETTINGS`.
- **Every failure attaches the uploaded PDF (`config.cv`).** No failure may prevent an email from being drafted.
- **CV rendering launches a fresh headless browser** — never `launchPersistentContext`, never `./profile`.
- Extraction model: `process.env.JOBFINDER_CV_MODEL || 'gpt-5-mini'`.
- Cache file: `data/cv/master.json`. Tailored PDFs: `join('data', 'cv', 'tailored', slug(recruiterEmail), basename(config.cv))`.
- **The procedure stays byte-identical for everyone:** the master CV is injected *above* `PROMPT_SEPARATOR` and must never itself contain `\n\n---\n\n`.
- **Ids are shown to the model in parentheses, never square brackets** — `PLACEHOLDER` rejects square brackets, so a copied `[r0.b3]` would cost an email.
- System prompt budget: `PROMPT_BUDGET = 28_000` characters. Over it, the master CV is not injected and the uploaded PDF is attached.
- `npm run typecheck` does **not** cover `scraper/`. Nothing in this plan lives there.
- Before every commit: `npm test`, `npm run lint`, `npm run typecheck` all exit 0. Style-only lint failures: `npx eslint --fix <file>`.
- Commit messages follow the repo's style — a plain sentence, not `feat:` — and end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/settings.ts` (modify) | `tailorCv` in the schema and `EMPTY_SETTINGS` |
| `app/pages/settings.vue` (modify) | The switch, in the CV card |
| `server/utils/cv-master.ts` (create) | Master CV types, id assignment, the PDF-text match, the cached loader, the prompt block |
| `server/utils/cv-tailor.ts` (create) | `tailoredCv` — the seven rules |
| `server/utils/cv-render.ts` (create) | `renderCvHtml`, the lazy headless renderer, the tailored path |
| `server/utils/cv-attach.ts` (create) | Which PDF an application and a follow-up attach, with the log note |
| `server/utils/drafter.ts` (modify) | `cv: z.unknown()`, master CV injection, `PROMPT_BUDGET` |
| `server/prompts/drafter-procedure.md` (modify) | The Tailored CV section |
| `server/db/schema.ts` + generated migration | `contacts.cv_path` |
| `server/utils/drafts.ts` (modify) | `persist` writes `cv_path`; export `slug`; `StoredDraft.cv` |
| `server/utils/jobs.ts` (modify) | Wire the apply path |
| `server/utils/sync.ts` (modify) | The follow-up reuses `contacts.cv_path` |
| `scripts/preview-cv.ts` (create) | Render the master CV unchanged, to compare the template with the uploaded PDF |
| `test/cv.test.ts` (create) | Every pure CV test |
| `test/cv-persist.test.ts` (create) | `cv_path` against a migrated database |
| `test/settings.test.ts`, `test/drafter.test.ts`, `test/invariants.test.ts` (modify) | |
| `CLAUDE.md` (modify) | Document the feature; correct the stale CV size |

---

### Task 1: The `tailorCv` switch

**Files:**
- Modify: `shared/settings.ts` — the schema line after `contactChannels`, and `EMPTY_SETTINGS` after `contactChannels`
- Modify: `app/pages/settings.vue` — the CV card
- Test: `test/settings.test.ts`

**Interfaces:**
- Produces: `StoredSettings['tailorCv']: boolean`, default `false`.

- [ ] **Step 1: Write the failing test** — append to `test/settings.test.ts` (it already imports `emptySettings`, `upgradeSettings`, `EMPTY_SETTINGS` and `StoredSettings`):

```ts
test('a settings row written before tailorCv existed reads as switched off, in form key order', () => {
  // An existing install must behave exactly as it did until the owner opts in. Key order matters as
  // much as the value: the Settings page's dirty check is a JSON.stringify comparison.
  const legacy = emptySettings() as Record<string, unknown>
  delete legacy.tailorCv
  const upgraded = upgradeSettings(legacy) as StoredSettings
  assert.equal(upgraded.tailorCv, false)
  assert.deepEqual(Object.keys(upgraded), Object.keys(EMPTY_SETTINGS))
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/settings.test.ts`
Expected: FAIL — `Expected values to be strictly equal: undefined !== false`.

- [ ] **Step 3: Add the field to the schema** — in `shared/settings.ts`, directly after the `contactChannels: z.array(z.enum(CONTACT_CHANNELS)),` line:

```ts
  // Attach a CV tailored to each application instead of the uploaded PDF. Off by default so an existing
  // install is unchanged, and the rollback lever if a tailored CV ever looks wrong: switching it off puts
  // every draft back on the uploaded PDF with no code change.
  // See docs/superpowers/specs/2026-09-17-tailored-cv-design.md.
  tailorCv: z.boolean(),
```

- [ ] **Step 4: Add the default** — in `EMPTY_SETTINGS`, directly after `contactChannels: ['email'],`:

```ts
  tailorCv: false,
```

- [ ] **Step 5: Add the switch to the form** — in `app/pages/settings.vue`, in the CV card's `<div class="space-y-4">`, insert this between the closing `</div>` of the Prefill row and `<p v-if="status.cv"`:

```vue
          <USwitch
            v-model="form.tailorCv"
            label="Tailor the CV to each application"
            description="Reorders and rewords this CV in each post's own terms — the same facts, checked in code — and attaches that instead. Any failure attaches this PDF unchanged."
          />
```

- [ ] **Step 6: Run everything**

Run: `npm test` — Expected: all pass, including the new test and the existing `the schema shape order matches EMPTY_SETTINGS key order, at every level`.
Run: `npm run lint` and `npm run typecheck` — Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add shared/settings.ts app/pages/settings.vue test/settings.test.ts
git commit -m "Add the off-by-default switch for a tailored CV

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Master CV — types, ids and the PDF-text match

**Files:**
- Create: `server/utils/cv-master.ts`
- Create: `test/cv.test.ts`

**Interfaces:**
- Produces (every later task relies on these exact names):

```ts
export interface CvContent {
  summary: string
  roles: { title: string, employer: string, location: string, start: string, end: string, bullets: string[] }[]
  skills: { group: string, items: string[] }[]
  education: string[]
  certifications: string[]
  languages: string[]
}
export interface MasterBullet { id: string, text: string }
export interface MasterRole { id: string, title: string, employer: string, location: string, start: string, end: string, bullets: MasterBullet[] }
export interface MasterSkillGroup { id: string, group: string, items: string[] }
export interface MasterCv {
  summary: string
  roles: MasterRole[]
  skills: MasterSkillGroup[]
  education: string[]
  certifications: string[]
  languages: string[]
}
export function assignIds(cv: CvContent): MasterCv
export function toContent(master: MasterCv): CvContent
export const matchKey: (text: string) => string
export function missingBullets(master: MasterCv, verbatim: string): string[]
export const pdfSha256: (bytes: Uint8Array) => string
```

- Produces (test fixtures in `test/cv.test.ts`, used by Tasks 3, 4, 5, 6, 8, 9): `content()`, `verbatim`.

- [ ] **Step 1: Write the failing tests** — create `test/cv.test.ts`:

```ts
// The tailored CV, tested without a model, a browser or a database: ids, the PDF-text match, the seven
// rules, rendering and the attachment decision. See docs/superpowers/specs/2026-09-17-tailored-cv-design.md.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignIds, matchKey, missingBullets, pdfSha256, toContent, type CvContent } from '../server/utils/cv-master.ts'

/** A neutral CV — nobody's real career. */
const content = (): CvContent => ({
  summary: 'Backend engineer with 9 years building payment systems on .NET and PostgreSQL.',
  roles: [
    {
      title: 'Engineering Manager',
      employer: 'Example Corp',
      location: 'Remote',
      start: '2021',
      end: 'Present',
      bullets: [
        'Led a team of 12 engineers across backend and DevOps.',
        'Migrated the billing service from MySQL to PostgreSQL with zero downtime.',
        'Cut invoice generation latency by 40% through query plan tuning.'
      ]
    },
    {
      title: 'Senior Software Engineer',
      employer: 'Sample Ltd',
      location: 'Remote',
      start: '2016',
      end: '2021',
      bullets: ['Built REST APIs in C# and ASP.NET Core for a payments integration.']
    }
  ],
  skills: [
    { group: 'Backend', items: ['C#', '.NET', 'ASP.NET Core'] },
    { group: 'Data', items: ['PostgreSQL', 'Redis'] }
  ],
  education: ['BSc Computer Science, Example University, 2015'],
  certifications: ['Cloud Architect Certification'],
  languages: ['English (native)', 'Spanish (professional)']
})

/** What a verbatim extraction of that CV's PDF looks like: glyphs, headings and a wrapped line. */
const verbatim = [
  'SUMMARY',
  'Backend engineer with 9 years building payment systems on .NET and PostgreSQL.',
  'EXPERIENCE',
  'Engineering Manager — Example Corp, Remote (2021 – Present)',
  '• Led a team of 12 engineers across backend and',
  '  DevOps.',
  '• Migrated the billing service from MySQL to PostgreSQL with zero downtime.',
  '• Cut invoice generation latency by 40% through query plan tuning.',
  'Senior Software Engineer — Sample Ltd, Remote (2016 – 2021)',
  '• Built REST APIs in C# and ASP.NET Core for a payments integration.'
].join('\n')

test('ids are assigned by code, deterministically, in document order', () => {
  const a = assignIds(content())
  assert.deepEqual(a, assignIds(content()))
  assert.deepEqual(a.roles.map(r => r.id), ['r0', 'r1'])
  assert.deepEqual(a.roles[0]!.bullets.map(b => b.id), ['r0.b0', 'r0.b1', 'r0.b2'])
  assert.deepEqual(a.skills.map(s => s.id), ['s0', 's1'])
})

test('toContent strips the ids and gives the extraction back unchanged', () => {
  assert.deepEqual(toContent(assignIds(content())), content())
})

test('matchKey survives ligatures, line wraps, bullet glyphs and case', () => {
  assert.equal(matchKey('eﬃcient ﬁle'), matchKey('efficient file'))
  assert.equal(matchKey('• Led a team\n  of 12'), matchKey('led a team of 12'))
})

test('every extracted bullet is found in the verbatim PDF text, even across a line wrap', () => {
  assert.deepEqual(missingBullets(assignIds(content()), verbatim), [])
})

test('a bullet the extraction invented is caught, by id', () => {
  const cv = content()
  cv.roles[1]!.bullets.push('Designed a platform for 50 services.')
  assert.deepEqual(missingBullets(assignIds(cv), verbatim), ['r1.b1'])
})

test('the PDF hash follows the bytes and nothing else', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)
  const a = pdfSha256(bytes('%PDF-1.4 a'))
  assert.equal(a, pdfSha256(bytes('%PDF-1.4 a')))
  assert.notEqual(a, pdfSha256(bytes('%PDF-1.4 b')))
  assert.match(a, /^[0-9a-f]{64}$/)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cv.test.ts`
Expected: FAIL — `Cannot find module '…/server/utils/cv-master.ts'`.

- [ ] **Step 3: Implement** — create `server/utils/cv-master.ts`:

```ts
// The master CV: the uploaded PDF, read once into structured content and cached against its bytes.
//
// Every rule a tailored CV is checked against (cv-tailor.ts) is anchored on the ids assigned here. They
// are assigned by code rather than by the model because they must be deterministic and unique.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md.
import { createHash } from 'node:crypto'

export interface CvContent {
  summary: string
  roles: { title: string, employer: string, location: string, start: string, end: string, bullets: string[] }[]
  skills: { group: string, items: string[] }[]
  education: string[]
  certifications: string[]
  languages: string[]
}

export interface MasterBullet { id: string, text: string }
export interface MasterRole {
  id: string
  title: string
  employer: string
  location: string
  start: string
  end: string
  bullets: MasterBullet[]
}
export interface MasterSkillGroup { id: string, group: string, items: string[] }
export interface MasterCv {
  summary: string
  roles: MasterRole[]
  skills: MasterSkillGroup[]
  education: string[]
  certifications: string[]
  languages: string[]
}

export function assignIds(cv: CvContent): MasterCv {
  return {
    summary: cv.summary,
    roles: cv.roles.map((r, i) => ({
      id: `r${i}`,
      title: r.title,
      employer: r.employer,
      location: r.location,
      start: r.start,
      end: r.end,
      bullets: r.bullets.map((text, j) => ({ id: `r${i}.b${j}`, text }))
    })),
    skills: cv.skills.map((s, i) => ({ id: `s${i}`, group: s.group, items: [...s.items] })),
    education: [...cv.education],
    certifications: [...cv.certifications],
    languages: [...cv.languages]
  }
}

export function toContent(master: MasterCv): CvContent {
  return {
    summary: master.summary,
    roles: master.roles.map(r => ({
      title: r.title,
      employer: r.employer,
      location: r.location,
      start: r.start,
      end: r.end,
      bullets: r.bullets.map(b => b.text)
    })),
    skills: master.skills.map(s => ({ group: s.group, items: [...s.items] })),
    education: [...master.education],
    certifications: [...master.certifications],
    languages: [...master.languages]
  }
}

/**
 * The form two texts are compared in. NFKC folds the ligatures a PDF often carries ("ﬁ") into plain
 * letters, and dropping everything but letters and digits means a line wrap, a bullet glyph or a changed
 * dash can never make a real bullet look missing. Unicode-aware, so an Arabic CV compares too.
 */
export const matchKey = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Ids of extracted bullets that do not appear in the verbatim text of the same PDF. Nobody reviews the
 * cache, so this is the defence against the extraction inventing or merging a bullet.
 * ponytail: two independent model calls agreeing, not a proof — the verbatim text is model output too.
 */
export function missingBullets(master: MasterCv, verbatim: string): string[] {
  const haystack = matchKey(verbatim)
  return master.roles
    .flatMap(r => r.bullets)
    .filter(b => !haystack.includes(matchKey(b.text)))
    .map(b => b.id)
}

export const pdfSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/cv.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run everything, then commit**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0.

```bash
git add server/utils/cv-master.ts test/cv.test.ts
git commit -m "Give the master CV code-assigned ids and a check against the PDF's own text

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Master CV — the cached loader

**Files:**
- Modify: `server/utils/cv-master.ts`
- Test: `test/cv.test.ts`

**Interfaces:**
- Consumes: `CvContent`, `MasterCv`, `assignIds`, `missingBullets`, `pdfSha256` (Task 2); fixtures `content()`, `verbatim` (Task 2).
- Produces:

```ts
export const MASTER_CACHE = 'data/cv/master.json'
export interface CachedMaster { pdfSha256: string, extractedAt: string, model: string, cv: MasterCv }
export interface Extractor {
  model: string
  extract: (pdfPath: string) => Promise<CvContent>
  verbatim: (pdfPath: string) => Promise<string>
}
export function openAiExtractor(): Extractor
export async function loadMasterCv(pdfPath: string, extractor?: Extractor, cachePath?: string): Promise<MasterCv>
```

- [ ] **Step 1: Write the failing tests** — add to the imports at the top of `test/cv.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
```

and add `loadMasterCv` and `type Extractor` to the existing `cv-master.ts` import. Then append:

```ts
const fakeExtractor = (over: { content?: CvContent } = {}) => {
  const calls = { extract: 0, verbatim: 0 }
  const extractor: Extractor = {
    model: 'fake-model',
    extract: async () => {
      calls.extract++
      return over.content ?? content()
    },
    verbatim: async () => {
      calls.verbatim++
      return verbatim
    }
  }
  return { extractor, calls }
}

/** A throwaway PDF and cache location; call `done()` in `finally`. */
const scratch = (bytes: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'jobfinder-cv-'))
  const pdf = join(dir, 'cv.pdf')
  writeFileSync(pdf, bytes)
  return { pdf, cache: join(dir, 'master.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the first load extracts and caches; the second is served from the cache', async () => {
  const s = scratch('%PDF-1.4 one')
  try {
    const { extractor, calls } = fakeExtractor()
    const first = await loadMasterCv(s.pdf, extractor, s.cache)
    const second = await loadMasterCv(s.pdf, extractor, s.cache)
    assert.deepEqual(first, second)
    assert.deepEqual(calls, { extract: 1, verbatim: 1 })
    assert.equal(JSON.parse(readFileSync(s.cache, 'utf8')).model, 'fake-model')
  } finally {
    s.done()
  }
})

test('a new PDF invalidates the cache with no extra code: its bytes, and so its hash, changed', async () => {
  const s = scratch('%PDF-1.4 one')
  try {
    const { extractor, calls } = fakeExtractor()
    await loadMasterCv(s.pdf, extractor, s.cache)
    writeFileSync(s.pdf, '%PDF-1.4 two')
    await loadMasterCv(s.pdf, extractor, s.cache)
    assert.equal(calls.extract, 2)
  } finally {
    s.done()
  }
})

test('an extraction carrying a bullet the PDF text lacks is refused, and nothing is cached', async () => {
  const s = scratch('%PDF-1.4 one')
  try {
    const bad = content()
    bad.roles[0]!.bullets.push('Invented a scheduler nobody built.')
    await assert.rejects(loadMasterCv(s.pdf, fakeExtractor({ content: bad }).extractor, s.cache), /r0\.b3/)
    assert.throws(() => readFileSync(s.cache, 'utf8'))
  } finally {
    s.done()
  }
})

test('an extraction with no roles is refused — the empty table a weak model returns under a strict schema', async () => {
  const s = scratch('%PDF-1.4 one')
  try {
    const empty = { ...content(), roles: [] }
    await assert.rejects(loadMasterCv(s.pdf, fakeExtractor({ content: empty }).extractor, s.cache), /no roles/)
  } finally {
    s.done()
  }
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cv.test.ts`
Expected: FAIL — `does not provide an export named 'loadMasterCv'`.

- [ ] **Step 3: Implement** — in `server/utils/cv-master.ts`, replace the import line with:

```ts
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import OpenAI from 'openai'
```

then append to the file:

```ts
export const MASTER_CACHE = 'data/cv/master.json'

export interface CachedMaster { pdfSha256: string, extractedAt: string, model: string, cv: MasterCv }

/** The two model calls, injectable so the cache logic is testable without a network. */
export interface Extractor {
  model: string
  extract: (pdfPath: string) => Promise<CvContent>
  verbatim: (pdfPath: string) => Promise<string>
}

const list = { type: 'array', items: { type: 'string' } } as const

const CV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'roles', 'skills', 'education', 'certifications', 'languages'],
  properties: {
    summary: { type: 'string' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'employer', 'location', 'start', 'end', 'bullets'],
        properties: {
          title: { type: 'string' },
          employer: { type: 'string' },
          location: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          bullets: list
        }
      }
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['group', 'items'],
        properties: { group: { type: 'string' }, items: list }
      }
    },
    education: list,
    certifications: list,
    languages: list
  }
} as const

const EXTRACT_INSTRUCTIONS = [
  'Extract this CV into the schema, copying text exactly as it is written.',
  'Copy every bullet verbatim: never reword, merge, split, summarise or correct one.',
  'Keep roles in the order the CV lists them. Use an empty string or an empty list for anything absent.',
  'Leave out the name and the contact details; they are supplied elsewhere.'
].join(' ')

/**
 * gpt-5-mini by default, not nano: nano satisfied a strict schema in background.post.ts by returning an
 * empty table, and an empty extraction here would silently turn tailoring off.
 */
export function openAiExtractor(): Extractor {
  const model = process.env.JOBFINDER_CV_MODEL || 'gpt-5-mini'
  const file = (pdfPath: string) => ({
    type: 'input_file',
    filename: basename(pdfPath),
    file_data: `data:application/pdf;base64,${readFileSync(pdfPath).toString('base64')}`
  })
  return {
    model,
    extract: async (pdfPath) => {
      const r = await new OpenAI().responses.create({
        model,
        reasoning: { effort: 'low' },
        input: [{ role: 'user', content: [file(pdfPath), { type: 'input_text', text: EXTRACT_INSTRUCTIONS }] }],
        text: { format: { type: 'json_schema', name: 'master_cv', strict: true, schema: CV_SCHEMA } }
      } as never) as { output_text: string }
      return JSON.parse(r.output_text) as CvContent
    },
    verbatim: async (pdfPath) => {
      const r = await new OpenAI().responses.create({
        model,
        reasoning: { effort: 'low' },
        input: [{
          role: 'user',
          content: [file(pdfPath), { type: 'input_text', text: 'Return the complete plain text of this document verbatim, with no commentary.' }]
        }]
      } as never) as { output_text: string }
      return r.output_text
    }
  }
}

function readCache(path: string): CachedMaster | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CachedMaster
  } catch {
    return null // absent or unreadable: rebuilt below, never fatal
  }
}

/**
 * The master CV for the PDF at `pdfPath`: from the cache while its hash matches the PDF, extracted and
 * cached otherwise — so uploading a new CV invalidates it with no extra code. Throws, and caches nothing,
 * when the extraction cannot be trusted; the caller attaches the uploaded PDF instead.
 */
export async function loadMasterCv(
  pdfPath: string,
  extractor: Extractor = openAiExtractor(),
  cachePath: string = MASTER_CACHE
): Promise<MasterCv> {
  const hash = pdfSha256(readFileSync(pdfPath))
  const cached = readCache(cachePath)
  if (cached?.pdfSha256 === hash) return cached.cv

  const [extracted, text] = await Promise.all([extractor.extract(pdfPath), extractor.verbatim(pdfPath)])
  const master = assignIds(extracted)
  if (!master.roles.length) throw new Error('the CV extraction returned no roles')
  const missing = missingBullets(master, text)
  if (missing.length) {
    throw new Error(`the CV extraction produced bullets the PDF text does not contain: ${missing.join(', ')} — nothing cached`)
  }

  mkdirSync(dirname(cachePath), { recursive: true })
  const record: CachedMaster = { pdfSha256: hash, extractedAt: new Date().toISOString(), model: extractor.model, cv: master }
  writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`)
  return master
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/cv.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run everything, then commit**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0.

```bash
git add server/utils/cv-master.ts test/cv.test.ts
git commit -m "Extract the master CV once and cache it against the PDF's hash

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The check — `tailoredCv`

**Files:**
- Create: `server/utils/cv-tailor.ts`
- Test: `test/cv.test.ts`

**Interfaces:**
- Consumes: `CvContent`, `MasterCv`, `assignIds` (Task 2); `PLACEHOLDER` from `server/utils/drafter.ts` (existing); fixture `content()` (Task 2).
- Produces:

```ts
export type TailorResult = { ok: true, cv: CvContent } | { ok: false, reason: string }
export function tailoredCv(raw: unknown, master: MasterCv): TailorResult
```

  Rejection reasons start with `rule N` or `rule N at <id>` (`malformed cv block` for a bad shape); Task 8 logs them verbatim.
- Produces (fixtures in `test/cv.test.ts`, used by Tasks 5 and 8): `master()`, `tailored()`.

- [ ] **Step 1: Write the failing tests** — add `import { tailoredCv } from '../server/utils/cv-tailor.ts'` to the imports of `test/cv.test.ts`, then append:

```ts
const master = () => assignIds(content())

/** Reordered and reworded strictly within the rules: the case that must pass. */
const tailored = () => ({
  summary: 'Backend engineer with 9 years delivering payment systems on .NET and PostgreSQL.',
  roles: [
    {
      id: 'r0',
      bullets: [
        { id: 'r0.b2', text: 'Reduced invoice generation latency by 40% by tuning query plans.' },
        { id: 'r0.b0', text: 'Managed a team of 12 engineers spanning backend and DevOps.' },
        { id: 'r0.b1', text: 'Moved the billing service from MySQL to PostgreSQL with zero downtime.' }
      ]
    },
    {
      id: 'r1',
      bullets: [{ id: 'r1.b0', text: 'Delivered REST APIs in C# and ASP.NET Core for a payments integration.' }]
    }
  ],
  skills: [
    { id: 's1', items: ['Redis', 'PostgreSQL'] },
    { id: 's0', items: ['ASP.NET Core', 'C#', '.NET'] }
  ]
})

const rejects = (mutate: (t: ReturnType<typeof tailored>) => void, reason: RegExp) => {
  const t = tailored()
  mutate(t)
  const r = tailoredCv(t, master())
  assert.equal(r.ok, false, 'expected a rejection')
  if (!r.ok) assert.match(r.reason, reason)
}

test('a CV reordered and reworded within the rules passes, roles still in date order', () => {
  // As important as every rejection below: without it, a check that rejected everything would pass
  // the whole suite while tailoring silently never happened.
  const r = tailoredCv(tailored(), master())
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.deepEqual(r.cv.roles.map(x => x.title), ['Engineering Manager', 'Senior Software Engineer'])
  assert.equal(r.cv.roles[0]!.bullets[0], 'Reduced invoice generation latency by 40% by tuning query plans.')
  assert.deepEqual(r.cv.skills.map(s => s.group), ['Data', 'Backend'])
  assert.deepEqual(r.cv.education, content().education)
})

test('a malformed cv block is a rejection, never a throw', () => {
  const r = tailoredCv({ summary: 'no roles at all' }, master())
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /^malformed cv block/)
})

test('rule 1: roles out of date order are rejected', () => {
  rejects(t => t.roles.reverse(), /^rule 1/)
})

test('rule 2: a dropped bullet is rejected', () => {
  rejects(t => t.roles[0]!.bullets.pop(), /^rule 2 at r0/)
})

test('rule 2: a bullet moved to another role is rejected', () => {
  rejects((t) => {
    t.roles[1]!.bullets.push(t.roles[0]!.bullets.pop()!)
  }, /^rule 2 at r0/)
})

test('rule 3: a renamed skill is rejected', () => {
  rejects((t) => {
    t.skills[0]!.items[0] = 'Redis Cache'
  }, /^rule 3 at s1/)
})

test('rule 4: a number its source bullet never carried is rejected', () => {
  rejects((t) => {
    t.roles[0]!.bullets[0]!.text = 'Reduced invoice generation latency by 60% by tuning query plans.'
  }, /^rule 4 at r0\.b2: "60"/)
})

test('rule 5: a technology the master CV never names is rejected, even when a post asked for it', () => {
  rejects((t) => {
    t.roles[1]!.bullets[0]!.text = 'Delivered REST APIs in C# and ASP.NET Core on AWS for a payments integration.'
  }, /^rule 5 at r1\.b0: "AWS"/)
})

test('rule 5 ceiling, recorded in the spec: an invented technology in mixed case is not caught', () => {
  // Pins today's behaviour so tightening the heuristic is a deliberate, visible change to this test.
  const t = tailored()
  t.roles[1]!.bullets[0]!.text = 'Delivered REST APIs in C# and ASP.NET Core on Kubernetes for payments.'
  assert.equal(tailoredCv(t, master()).ok, true)
})

test('rule 6: a bullet stuffed past 1.5x its source plus 20 characters is rejected', () => {
  rejects((t) => {
    t.roles[0]!.bullets[1]!.text = 'Managed a team of 12 engineers spanning backend and DevOps, '.repeat(3)
  }, /^rule 6 at r0\.b0/)
})

test('rule 7: an unfilled placeholder in a bullet is rejected', () => {
  rejects((t) => {
    t.roles[0]!.bullets[2]!.text = 'Moved the billing service to [DATABASE] with zero downtime.'
  }, /^rule 7 at r0\.b1/)
})

test('the summary is held to rules 4, 5 and 7, against the whole master CV', () => {
  rejects((t) => {
    t.summary = 'Backend engineer with 15 years on .NET and PostgreSQL.'
  }, /^rule 4 at summary: "15"/)
  rejects((t) => {
    t.summary = 'Backend engineer with 9 years on .NET and GCP.'
  }, /^rule 5 at summary: "GCP"/)
  rejects((t) => {
    t.summary = 'Backend engineer with 9 years on [STACK].'
  }, /^rule 7 at summary/)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cv.test.ts`
Expected: FAIL — `Cannot find module '…/server/utils/cv-tailor.ts'`.

- [ ] **Step 3: Implement** — create `server/utils/cv-tailor.ts`:

```ts
// The check a tailored CV must pass before it is rendered. The first failure rejects the whole CV and
// the uploaded PDF is attached instead (cv-attach.ts).
//
// In code rather than in the procedure for the reason PLACEHOLDER and gateOnPostType() are: the model
// follows a written instruction most of the time, and a stretched claim on a CV sent under the owner's
// name is exactly what "most of the time" cannot cover.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md, section 3.
import { z } from 'zod'
import type { CvContent, MasterCv } from './cv-master.ts'
import { PLACEHOLDER } from './drafter.ts'

const cvBlock = z.object({
  summary: z.string().min(1),
  roles: z.array(z.object({
    id: z.string(),
    bullets: z.array(z.object({ id: z.string(), text: z.string().min(1) }))
  })),
  skills: z.array(z.object({ id: z.string(), items: z.array(z.string()) }))
})

export type TailorResult = { ok: true, cv: CvContent } | { ok: false, reason: string }

const fail = (reason: string): TailorResult => ({ ok: false, reason })

/** Digit runs as the claim they carry: "40%" and "40" are one number, "60%" is another. */
const numbersIn = (text: string): string[] => text.match(/\d+(?:[.,]\d+)?/g) ?? []

/** Words, with trailing sentence punctuation dropped so "PostgreSQL." is "PostgreSQL". */
const tokens = (text: string): string[] =>
  text.split(/[\s,;:()/]+/).map(t => t.replace(/[.!?]+$/, '')).filter(Boolean)

/**
 * Looks like a technology name: letters with a digit, ".", "#" or "+" ("C#", ".NET", "Node.js", "ES6"),
 * or two or more capitals ("AWS"). Pure numbers are rule 4's business, not this one's.
 * ponytail: a shape heuristic — an invented technology in lower or mixed case ("Kubernetes") passes.
 * The spec records a tighter candidate, to be measured against real post text before adopting it.
 */
const isTech = (t: string): boolean => (/[a-z]/i.test(t) && /[\d.#+]/.test(t)) || /^[A-Z]{2,}$/.test(t)

const masterText = (m: MasterCv): string => [
  m.summary,
  ...m.roles.flatMap(r => [r.title, r.employer, r.location, r.start, r.end, ...r.bullets.map(b => b.text)]),
  ...m.skills.flatMap(s => [s.group, ...s.items]),
  ...m.education,
  ...m.certifications,
  ...m.languages
].join('\n')

/** Rules 4, 5, 6 (when a limit is given) and 7, in that order, for one piece of text. */
function contentProblem(where: string, text: string, sourceNumbers: string[], vocab: Set<string>, maxLength?: number): string | null {
  const known = new Set(sourceNumbers)
  const newNumber = numbersIn(text).find(n => !known.has(n))
  if (newNumber) return `rule 4 at ${where}: "${newNumber}" not in source`
  const newTech = tokens(text).filter(isTech).find(t => !vocab.has(t.toLowerCase()))
  if (newTech) return `rule 5 at ${where}: "${newTech}" is not in the master CV`
  if (maxLength !== undefined && text.length > maxLength) {
    return `rule 6 at ${where}: ${text.length} characters where the limit is ${maxLength}`
  }
  const hole = text.match(PLACEHOLDER)
  if (hole) return `rule 7 at ${where}: unfilled placeholder ${hole[0]}`
  return null
}

export function tailoredCv(raw: unknown, master: MasterCv): TailorResult {
  const parsed = cvBlock.safeParse(raw)
  if (!parsed.success) return fail(`malformed cv block: ${parsed.error.issues[0]?.message ?? 'unreadable'}`)
  const t = parsed.data
  const inOrder = (xs: { id: string }[]) => xs.map(x => x.id).join(',')
  const asSet = (xs: { id: string }[]) => xs.map(x => x.id).sort().join(',')

  // rule 1 — the same roles, in the master's date order
  if (inOrder(t.roles) !== inOrder(master.roles)) {
    return fail(`rule 1: roles ${inOrder(t.roles)} do not match ${inOrder(master.roles)} in date order`)
  }

  // rule 2 — each role's own bullets, each exactly once: none added, dropped or moved between roles
  for (const [i, role] of master.roles.entries()) {
    if (asSet(t.roles[i]!.bullets) !== asSet(role.bullets)) {
      return fail(`rule 2 at ${role.id}: bullets ${asSet(t.roles[i]!.bullets)} do not match ${asSet(role.bullets)}`)
    }
  }

  // rule 3 — the same skill groups in any order, each group's items reordered only
  if (asSet(t.skills) !== asSet(master.skills)) {
    return fail(`rule 3: skill groups ${asSet(t.skills)} do not match ${asSet(master.skills)}`)
  }
  for (const group of t.skills) {
    const source = master.skills.find(s => s.id === group.id)!
    if ([...group.items].sort().join('\n') !== [...source.items].sort().join('\n')) {
      return fail(`rule 3 at ${group.id}: items were renamed, added or removed`)
    }
  }

  // rules 4-7 — each bullet against its own source bullet
  const vocab = new Set(tokens(masterText(master)).map(x => x.toLowerCase()))
  for (const [i, role] of master.roles.entries()) {
    for (const bullet of t.roles[i]!.bullets) {
      const source = role.bullets.find(b => b.id === bullet.id)!
      const limit = Math.floor(source.text.length * 1.5) + 20
      const problem = contentProblem(bullet.id, bullet.text, numbersIn(source.text), vocab, limit)
      if (problem) return fail(problem)
    }
  }

  // rules 4, 5 and 7 — the summary, against the whole master CV
  const summaryProblem = contentProblem('summary', t.summary, numbersIn(masterText(master)), vocab)
  if (summaryProblem) return fail(summaryProblem)

  return {
    ok: true,
    cv: {
      summary: t.summary,
      roles: master.roles.map((role, i) => ({
        title: role.title,
        employer: role.employer,
        location: role.location,
        start: role.start,
        end: role.end,
        bullets: t.roles[i]!.bullets.map(b => b.text)
      })),
      skills: t.skills.map(g => ({ group: master.skills.find(s => s.id === g.id)!.group, items: [...g.items] })),
      education: [...master.education],
      certifications: [...master.certifications],
      languages: [...master.languages]
    }
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/cv.test.ts`
Expected: PASS, 22 tests. If the passing case fails, read its message — it names the rule and id — and fix the implementation, not the fixture: the fixture is written to sit inside every rule.

- [ ] **Step 5: Run everything, then commit**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0.

```bash
git add server/utils/cv-tailor.ts test/cv.test.ts
git commit -m "Check a tailored CV against its master in code: nothing added, moved or inflated

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The drafter's contract

**Files:**
- Modify: `server/utils/cv-master.ts` (add `MASTER_CV_HEADING`, `masterCvBlock`)
- Modify: `server/utils/drafter.ts` (`responseSchema`, `buildSystemPrompt`, `PROMPT_BUDGET`, `fitsPromptBudget`, `RunOptions`, `runDrafter`)
- Modify: `server/prompts/drafter-procedure.md` (a Tailored CV section, and one line in *Before you return*)
- Test: `test/cv.test.ts`, `test/drafter.test.ts`

**Interfaces:**
- Consumes: `MasterCv`, `assignIds` (Task 2); fixture `master()` (Task 4).
- Produces:

```ts
// cv-master.ts
export const MASTER_CV_HEADING = '# Master CV — tailor from this, and only this'
export function masterCvBlock(master: MasterCv): string
// drafter.ts
export const PROMPT_BUDGET = 28_000
export function buildSystemPrompt(config: AppConfig, master?: MasterCv | null): string
export const fitsPromptBudget: (config: AppConfig, master: MasterCv) => boolean
export interface RunOptions { onLog?, signal?, timeoutMs?, masterCv?: MasterCv | null }
// DraftResponse gains: cv?: unknown
```

- [ ] **Step 1: Write the failing tests** — in `test/cv.test.ts`, add `masterCvBlock` to the `cv-master.ts` import, then append:

```ts
test('the master CV block gives every bullet its id — in parentheses, never square brackets', () => {
  const block = masterCvBlock(master())
  assert.match(block, /\(r0\.b1\) Migrated the billing service/)
  assert.match(block, /\(s0\) Backend: C# \| \.NET \| ASP\.NET Core/)
  // PLACEHOLDER rejects square brackets, so a copied "[r0.b3]" would cost the email it landed in
  assert.doesNotMatch(block, /\[[rs]\d/)
  // a markdown rule would make PROMPT_SEPARATOR ambiguous
  assert.equal(block.includes('\n\n---\n\n'), false)
})
```

In `test/drafter.test.ts`, add `PROMPT_BUDGET` and `fitsPromptBudget` to the `drafter.ts` import, add `import { MASTER_CV_HEADING, assignIds } from '../server/utils/cv-master.ts'`, then append:

```ts
const cvContent = {
  summary: 'Backend engineer with 9 years on .NET.',
  roles: [{ title: 'Engineering Manager', employer: 'Example Corp', location: 'Remote', start: '2021', end: 'Present', bullets: ['Led a team of 12 engineers.'] }],
  skills: [{ group: 'Backend', items: ['C#', '.NET'] }],
  education: [],
  certifications: [],
  languages: []
}

test('a malformed cv block never fails the email it arrived with', () => {
  const parsed = parseResponse(JSON.stringify({ ...ok, cv: { roles: 'not an array' } }))
  assert.equal(parsed.results.length, ok.results.length)
  assert.deepEqual(parsed.cv, { roles: 'not an array' })
})

test('the master CV is injected above the separator, and the procedure still follows byte for byte', () => {
  const p = buildSystemPrompt(config, assignIds(cvContent))
  assert.ok(p.includes('(r0.b0) Led a team of 12 engineers.'))
  assert.ok(p.indexOf(MASTER_CV_HEADING) < p.indexOf(PROMPT_SEPARATOR), 'the master CV must sit ABOVE the separator')
  assert.ok(p.endsWith(readProcedure()))
  assert.equal(buildSystemPrompt(config).includes(MASTER_CV_HEADING), false, 'no master CV means no block')
})

test('a master CV that would push the prompt past PROMPT_BUDGET does not fit', () => {
  assert.equal(fitsPromptBudget(config, assignIds(cvContent)), true)
  assert.equal(fitsPromptBudget(config, assignIds({ ...cvContent, summary: 'x'.repeat(PROMPT_BUDGET) })), false)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cv.test.ts test/drafter.test.ts`
Expected: FAIL — `does not provide an export named 'masterCvBlock'` and `…'PROMPT_BUDGET'`.

- [ ] **Step 3: Add the block** — append to `server/utils/cv-master.ts`:

```ts
export const MASTER_CV_HEADING = '# Master CV — tailor from this, and only this'

/**
 * The master CV as the drafter sees it, every line carrying the id a tailored bullet must return.
 * Ids go in parentheses: PLACEHOLDER rejects square brackets, so a copied "[r0.b3]" would cost the email.
 * Plain lines and never a markdown rule, because PROMPT_SEPARATOR is itself one.
 */
export function masterCvBlock(master: MasterCv): string {
  return [
    MASTER_CV_HEADING,
    '',
    `Summary: ${master.summary}`,
    '',
    ...master.roles.flatMap(r => [
      `(${r.id}) ${r.title} — ${r.employer}, ${r.location} (${r.start} – ${r.end})`,
      ...r.bullets.map(b => `  (${b.id}) ${b.text}`)
    ]),
    '',
    ...master.skills.map(s => `(${s.id}) ${s.group}: ${s.items.join(' | ')}`)
  ].join('\n')
}
```

- [ ] **Step 4: Change the drafter** — in `server/utils/drafter.ts`:

Add below `import type { AppConfig } from './config'`:

```ts
import { masterCvBlock, type MasterCv } from './cv-master.ts'
```

In `responseSchema`, after `report: z.string().default('')`, add a comma and:

```ts
  // The tailored CV, deliberately untyped. Zod strips unknown keys, so without this line the block would
  // vanish silently; typed here, a malformed CV would fail the email it arrived with. tailoredCv() in
  // cv-tailor.ts validates it on its own, and any failure attaches the uploaded PDF.
  cv: z.unknown().optional()
```

Replace `buildSystemPrompt` with:

```ts
/**
 * The longest system prompt allowed. It travels on the command line (`--append-system-prompt`), Windows
 * caps a whole command line at 32,767 characters, and argument escaping inflates the prompt on the way.
 * Measured 2026-09-17: ~17,400 characters before a master CV, ~6,500 more with one.
 */
export const PROMPT_BUDGET = 28_000

export function buildSystemPrompt(config: AppConfig, master: MasterCv | null = null): string {
  const cv = master ? `\n\n${masterCvBlock(master)}` : ''
  return `${candidateBlock(config)}${cv}${PROMPT_SEPARATOR}${readProcedure()}`
}

/** False when injecting this master CV would push the prompt past PROMPT_BUDGET. */
export const fitsPromptBudget = (config: AppConfig, master: MasterCv): boolean =>
  buildSystemPrompt(config, master).length <= PROMPT_BUDGET
```

In `RunOptions`, add:

```ts
  /** Injected only when tailoring is on and fitsPromptBudget() holds — jobs.ts decides. */
  masterCv?: MasterCv | null
```

In `runDrafter`, change the system prompt argument to:

```ts
    '--append-system-prompt', buildSystemPrompt(config, opts.masterCv ?? null),
```

- [ ] **Step 5: Add the procedure section** — in `server/prompts/drafter-procedure.md`, insert this section immediately before `## Follow-up mode`:

````markdown
## Tailored CV

Only when a **Master CV** section is injected above. With none injected, return no `cv` key and ignore
this section.

In apply mode, add one top-level `cv` key beside `results` and `report`, tailoring the injected master CV
to the posts in this email:

```jsonc
"cv": {
  "summary": "…",
  "roles":  [{ "id": "r0", "bullets": [{ "id": "r0.b3", "text": "…" }] }],
  "skills": [{ "id": "s1", "items": ["…"] }]
}
```

- **Roles:** every role id, in the injected order. Never reorder roles.
- **Bullets:** every bullet id of a role exactly once, under that same role, most relevant first. Reword a
  bullet in the posts' own terms only where the fact stays exactly the same — never a number the bullet
  does not already carry, never a technology the master CV does not name, never more than half as long
  again.
- **Skills:** every group id, in any order; each group's items in any order and copied exactly — never
  renamed, added or removed.
- **Summary:** written for these roles, stating only facts the master CV contains.
- Education, certifications and languages are not returned; they are copied from the master CV unchanged.
- Never copy an id such as `r0.b3` into a bullet or into the email.

Every rule here is checked in code, and a CV that breaks any of them is discarded in favour of the
original. Staying inside them is the only way a tailored CV is actually sent.
````

Then in `## Before you return`, add this bullet at the end of the list:

```markdown
- With a Master CV injected and in apply mode, the `cv` key is present and follows the Tailored CV rules.
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `node --test test/cv.test.ts test/drafter.test.ts test/identity.test.ts`
Expected: PASS. `identity.test.ts` scans the procedure for gendered pronouns and contact shapes — the new section contains neither.

- [ ] **Step 7: Run everything, then commit**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0.

```bash
git add server/utils/cv-master.ts server/utils/drafter.ts server/prompts/drafter-procedure.md test/cv.test.ts test/drafter.test.ts
git commit -m "Let the drafter return a tailored CV block that can never fail its email

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Rendering

**Files:**
- Create: `server/utils/cv-render.ts`
- Create: `scripts/preview-cv.ts`
- Modify: `server/utils/drafts.ts` (export `slug`)
- Test: `test/cv.test.ts`

**Interfaces:**
- Consumes: `CvContent`, `loadMasterCv`, `toContent` (Tasks 2-3); `Profile` from `shared/settings.ts`; `slug` from `drafts.ts`; fixture `content()` (Task 2).
- Produces:

```ts
export function renderCvHtml(cv: CvContent, profile: Profile): string
export interface CvRenderer {
  render: (html: string, outPath: string) => Promise<number> // bytes written
  close: () => Promise<void>
}
export function createCvRenderer(launch?: () => Promise<Browser>): CvRenderer
export const tailoredCvPath: (cvPath: string, recruiterEmail: string) => string
```

- Produces (fixture in `test/cv.test.ts`, used by Task 8): `profile`.

- [ ] **Step 1: Export `slug`** — in `server/utils/drafts.ts`, change `const slug = (email: string) =>` to `export const slug = (email: string) =>`.

- [ ] **Step 2: Write the failing tests** — add to the imports of `test/cv.test.ts`:

```ts
import { emptySettings } from '../shared/settings.ts'
import { createCvRenderer, renderCvHtml, tailoredCvPath } from '../server/utils/cv-render.ts'
```

then append:

```ts
const profile = { ...emptySettings().profile, name: 'Test Person', title: 'Engineering Manager', email: 'test@example.com' }

test('renderCvHtml escapes every value, so a CV can never inject markup', () => {
  const cv = content()
  cv.roles[0]!.bullets[0] = 'Shipped <script>alert(1)</script> & more'
  const html = renderCvHtml(cv, profile)
  assert.equal(html.includes('<script>alert'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more'))
})

test('renderCvHtml renders every role, bullet and skill, in the CV\'s own font', () => {
  const html = renderCvHtml(content(), profile)
  for (const role of content().roles) {
    assert.ok(html.includes(role.title), role.title)
    for (const bullet of role.bullets) assert.ok(html.includes(bullet), bullet)
  }
  assert.ok(html.includes('ASP.NET Core'))
  assert.match(html, /font-family:\s*Carlito, Calibri, sans-serif/)
})

test('a tailored CV keeps the uploaded filename, in a folder of its own per recruiter', () => {
  // createDraft names the attachment basename(path), so this filename is what the recruiter sees
  assert.equal(tailoredCvPath('data/cv/My-CV.pdf', 'HR@Acme.sa'), join('data', 'cv', 'tailored', 'hr_acme_sa', 'My-CV.pdf'))
})

test('the renderer launches no browser until something is rendered', async () => {
  let launches = 0
  const renderer = createCvRenderer(async () => {
    launches++
    throw new Error('must not launch')
  })
  await renderer.close()
  assert.equal(launches, 0)
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `node --test test/cv.test.ts`
Expected: FAIL — `Cannot find module '…/server/utils/cv-render.ts'`.

- [ ] **Step 4: Implement** — create `server/utils/cv-render.ts`:

```ts
// Printing a CV: an HTML template modelled on the uploaded two-page layout, printed to PDF by headless
// Chrome. No templating dependency — a string, with every value escaped.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md, section 4.
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import type { Profile } from '../../shared/settings.ts'
import type { CvContent } from './cv-master.ts'
import { slug } from './drafts.ts'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Carlito is the uploaded CV's own face and is installed here; Calibri is its metric twin, so even the
// fallback breaks lines in the same places. Tune these values with scripts/preview-cv.ts.
const CSS = `
@page { size: A4; margin: 16mm 16mm 14mm; }
* { box-sizing: border-box; }
body { font-family: Carlito, Calibri, sans-serif; font-size: 10.5pt; line-height: 1.3; color: #111; margin: 0; }
header { margin-bottom: 8pt; }
h1 { font-size: 20pt; margin: 0; }
.title { font-size: 11.5pt; margin: 1pt 0 3pt; }
.contact { font-size: 9.5pt; color: #333; }
h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #999;
  margin: 10pt 0 4pt; padding-bottom: 1pt; }
.role { margin-bottom: 6pt; }
.role-head { display: flex; justify-content: space-between; gap: 8pt; font-weight: bold; }
.role-meta { font-style: italic; font-weight: normal; }
ul { margin: 2pt 0 0 14pt; padding: 0; }
li { margin: 0 0 1.5pt; break-inside: avoid; }
.skills p { margin: 0 0 2pt; }
`

export function renderCvHtml(cv: CvContent, profile: Profile): string {
  const contact = [profile.location, profile.email, profile.phone, profile.linkedin, profile.github]
    .filter(Boolean).map(esc).join(' · ')
  const list = (items: string[]) => items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''
  const section = (heading: string, body: string) => body ? `<h2>${heading}</h2>${body}` : ''
  const roles = cv.roles.map(r => [
    '<div class="role">',
    `<div class="role-head"><span>${esc(r.title)} — ${esc(r.employer)}</span>`,
    `<span class="role-meta">${esc([r.start, r.end].filter(Boolean).join(' – '))}</span></div>`,
    r.location ? `<div class="role-meta">${esc(r.location)}</div>` : '',
    list(r.bullets),
    '</div>'
  ].join('')).join('')
  const skills = cv.skills.map(s => `<p><strong>${esc(s.group)}:</strong> ${s.items.map(esc).join(', ')}</p>`).join('')

  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<style>${CSS}</style></head><body>`,
    `<header><h1>${esc(profile.name)}</h1>`,
    profile.title ? `<div class="title">${esc(profile.title)}</div>` : '',
    `<div class="contact">${contact}</div></header>`,
    section('Summary', cv.summary ? `<p>${esc(cv.summary)}</p>` : ''),
    section('Experience', roles),
    section('Skills', skills ? `<div class="skills">${skills}</div>` : ''),
    section('Education', list(cv.education)),
    section('Certifications', list(cv.certifications)),
    section('Languages', list(cv.languages)),
    '</body></html>'
  ].join('')
}

export interface CvRenderer {
  /** Prints `html` to `outPath`, creating its folder, and returns the bytes written. */
  render: (html: string, outPath: string) => Promise<number>
  close: () => Promise<void>
}

/**
 * One headless browser per draft job, launched on first use — so a batch whose every CV fell back
 * launches nothing — and closed by the caller in `finally`.
 *
 * A fresh, non-persistent browser, never the LinkedIn profile: the draft lane runs alongside the scrape
 * lane, which holds that profile's lock for the whole scrape. test/invariants.test.ts pins this.
 */
export function createCvRenderer(
  launch: () => Promise<Browser> = () => chromium.launch({ channel: 'chrome', headless: true })
): CvRenderer {
  let browser: Promise<Browser> | null = null
  return {
    render: async (html, outPath) => {
      browser ??= launch()
      const page = await (await browser).newPage()
      try {
        await page.setContent(html, { waitUntil: 'load' })
        // awaited inside the page: returning the FontFaceSet itself would make Playwright serialise it
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, pdf)
        return pdf.length
      } finally {
        await page.close()
      }
    },
    close: async () => {
      const b = await browser?.catch(() => null)
      await b?.close()
    }
  }
}

/**
 * Where a recruiter's tailored CV is written: a folder of its own, under the SAME filename as the uploaded
 * CV. createDraft names the attachment basename(path), so a tailored CV is indistinguishable by name.
 */
export const tailoredCvPath = (cvPath: string, recruiterEmail: string): string =>
  join('data', 'cv', 'tailored', slug(recruiterEmail), basename(cvPath))
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `node --test test/cv.test.ts`
Expected: PASS, 27 tests.

- [ ] **Step 6: Add the preview script** — create `scripts/preview-cv.ts`:

```ts
// Renders the master CV through the tailoring template with nothing changed, so the template can be
// compared with the uploaded PDF side by side. Run it after any change to the CSS in cv-render.ts.
//   node --env-file-if-exists=.env scripts/preview-cv.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { loadMasterCv, toContent } from '../server/utils/cv-master.ts'
import { createCvRenderer, renderCvHtml } from '../server/utils/cv-render.ts'
import { readSettingsFrom } from '../shared/settings.ts'

// 0 means the PDF uses compressed object streams — open it and count by eye.
const pages = (path: string) => (readFileSync(path, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length

const db = new Database(process.env.JOBFINDER_DB || 'data/jobfinder.db', { readonly: true })
const config = readSettingsFrom(db)
db.close()
if (!config?.cv) throw new Error('no CV configured — upload one in Settings')

const master = await loadMasterCv(config.cv)
const out = join('data', 'cv', 'tailored', '_preview', 'preview.pdf')
const renderer = createCvRenderer()
try {
  const bytes = await renderer.render(renderCvHtml(toContent(master), config.profile), out)
  console.log(`uploaded: ${config.cv} — ${pages(config.cv)} page(s)`)
  console.log(`preview:  ${out} — ${pages(out)} page(s), ${bytes} bytes`)
} finally {
  await renderer.close()
}
```

- [ ] **Step 7: Match the template to the uploaded CV** — this is the visual step the spec requires before shipping.

Run: `node --env-file-if-exists=.env scripts/preview-cv.ts`
Expected: two lines, `uploaded: … 2 page(s)` and `preview: … N page(s)`. The first run also creates `data/cv/master.json` (two OpenAI calls). If it throws `bullets the PDF text does not contain`, stop and report the ids: the extraction is not trustworthy on this CV, and that is a finding, not something to work around.

Open both PDFs side by side. In `server/utils/cv-render.ts`, adjust the `CSS` constant, and the order of the `section(...)` calls in `renderCvHtml` if the uploaded CV orders its sections differently, then re-run until:
- both are the same number of pages;
- sections appear in the same order;
- font sizes, heading style and spacing read as the same document.

After every edit, run `node --test test/cv.test.ts` — the rendering tests must stay green.

- [ ] **Step 8: Run everything, then commit**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0. `data/` is gitignored, so neither the preview nor `master.json` is committed; confirm with `git status --porcelain`.

```bash
git add server/utils/cv-render.ts server/utils/drafts.ts scripts/preview-cv.ts test/cv.test.ts
git commit -m "Print a CV in the uploaded CV's own layout and font, through headless Chrome

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Recording which CV each recruiter was sent

**Files:**
- Modify: `server/db/schema.ts` (the `contacts` table)
- Create: the migration `drizzle-kit` generates (`server/db/migrations/0006_*.sql` and its `meta/` updates)
- Modify: `server/utils/drafts.ts` (`persist`)
- Create: `test/cv-persist.test.ts`

**Interfaces:**
- Produces: column `contacts.cv_path` (nullable text); `persist(db, req, res, draftFile, cvPath: string | null = null)`.

- [ ] **Step 1: Write the failing tests** — create `test/cv-persist.test.ts`:

```ts
// Which CV a recruiter was sent, recorded on contacts.cv_path. The follow-up reuses it, so a follow-up
// must never overwrite it, and an application that fell back to the uploaded PDF must record null
// rather than leave an earlier tailored path looking like what was sent.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import Database from 'better-sqlite3'
import type { DraftRequest, DraftResponse } from '../server/utils/drafter.ts'
import { persist } from '../server/utils/drafts.ts'
import { applyRecord, type ScraperRecord } from '../server/utils/ingest.ts'

let dir: string
let db: Database.Database
const KEY = 'c'.repeat(40)
const TAILORED = join('data', 'cv', 'tailored', 'hr_acme_sa', 'cv.pdf')

const post: ScraperRecord = {
  op: 'post',
  key: KEY,
  searchTerm: 'engineering manager',
  author: 'A Recruiter',
  authorUrl: 'https://www.linkedin.com/in/recruiter',
  postUrl: null,
  postedAge: '3h',
  postedAt: '2026-09-17T09:00:00.000Z',
  postType: 'hiring',
  title: 'Engineering Manager',
  company: 'Acme',
  location: 'Remote',
  remote: true,
  inScope: true,
  emails: ['hr@acme.sa'],
  links: [],
  phones: [],
  refIds: [],
  channels: ['email'],
  score: 7,
  reason: 'Match: some',
  text: 'We are hiring. Send CV to hr@acme.sa',
  flags: []
} as ScraperRecord

const request = (mode: 'apply' | 'follow-up'): DraftRequest => ({
  mode,
  recruiterEmail: 'hr@acme.sa',
  posts: [{ key: KEY, title: 'Engineering Manager', company: 'Acme', location: 'Remote', score: 7, postType: 'hiring', flags: [], text: 'hiring' }]
})

const drafted = (mode: 'apply' | 'follow-up'): DraftResponse => ({
  results: [{
    key: KEY,
    verdict: 'drafted',
    reason: mode === 'apply' ? 'named in application; fit' : 'named in follow-up; still interested',
    subject: 'Engineering Manager',
    body: 'Hello'
  }],
  report: ''
})

const cvPathOnFile = () =>
  (db.prepare('SELECT cv_path FROM contacts WHERE email = ?').get('hr@acme.sa') as { cv_path: string | null }).cv_path

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobfinder-cvpath-'))
  execFileSync('npx', ['drizzle-kit', 'migrate'], { env: { ...process.env, JOBFINDER_DB: join(dir, 'test.db') }, stdio: 'ignore' })
  db = new Database(join(dir, 'test.db'))
  db.pragma('foreign_keys = ON')
  applyRecord(db, post)
})
after(() => {
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('an application records the tailored CV it carried', () => {
  persist(db, request('apply'), drafted('apply'), 'draft-1', TAILORED)
  assert.equal(cvPathOnFile(), TAILORED)
})

test('a follow-up never overwrites the CV its application carried', () => {
  persist(db, request('follow-up'), drafted('follow-up'), 'draft-2', null)
  assert.equal(cvPathOnFile(), TAILORED)
})

test('a re-drafted application that fell back records null, not the stale tailored path', () => {
  persist(db, request('apply'), drafted('apply'), 'draft-3', null)
  assert.equal(cvPathOnFile(), null)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cv-persist.test.ts`
Expected: FAIL — `no such column: cv_path`.

- [ ] **Step 3: Add the column** — in `server/db/schema.ts`, in `contacts`, directly after `note: text('note'),`:

```ts
  /**
   * The CV this recruiter was sent when it was a tailored one; null means the uploaded PDF went out.
   * Recorded rather than derived from the recruiter: a later re-draft that falls back would otherwise
   * leave the old tailored file on disk, looking like what was sent. The follow-up reuses it.
   */
  cvPath: text('cv_path'),
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `server/db/migrations/0006_<generated name>.sql` containing `ALTER TABLE \`contacts\` ADD \`cv_path\` text;`, plus an updated `meta/_journal.json` and a new `meta/0006_snapshot.json`. Open the `.sql` and confirm it holds that one statement and nothing else. The dev server applies it at boot (`server/plugins/migrate.ts`); do not run `npm run db:migrate` against the live database.

- [ ] **Step 5: Write `cv_path` in `persist`** — in `server/utils/drafts.ts`, add the parameter to the signature:

```ts
export function persist(
  db: Database.Database,
  req: DraftRequest,
  res: DraftResponse,
  draftFile: string | null,
  cvPath: string | null = null
): { drafted: number, skipped: number } {
```

and replace the `contacts` upsert statement and its `.run({...})` with:

```ts
      db.prepare(`
        INSERT INTO contacts (email, stage, note, cv_path, updated_at)
        VALUES (@email, @stage, @note, @cvPath, @now)
        ON CONFLICT (email) DO UPDATE SET
          stage = excluded.stage, note = excluded.note, updated_at = excluded.updated_at,
          cv_path = CASE WHEN @apply = 1 THEN excluded.cv_path ELSE contacts.cv_path END
        WHERE contacts.stage <> 'final'
      `).run({
        email: req.recruiterEmail.toLowerCase(),
        stage,
        note: draftFile ? `draft written to ${draftFile}` : null,
        // An application records the CV it carried, null included. A follow-up reuses that CV, so it
        // must never overwrite it — not with null, and not with a path of its own.
        cvPath: req.mode === 'apply' ? cvPath : null,
        apply: req.mode === 'apply' ? 1 : 0,
        now
      })
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `node --test test/cv-persist.test.ts test/manual-draft.test.ts test/dismiss.test.ts`
Expected: PASS — the new tests, and the existing `persist` tests unchanged.

- [ ] **Step 7: Run everything, then commit**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0.

```bash
git add server/db/schema.ts server/db/migrations server/utils/drafts.ts test/cv-persist.test.ts
git commit -m "Record on each contact which CV the application carried

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Tailoring the application

**Files:**
- Create: `server/utils/cv-attach.ts`
- Modify: `server/utils/jobs.ts` (`runDraftJob`)
- Modify: `server/utils/drafts.ts` (`StoredDraft`)
- Test: `test/cv.test.ts`

**Interfaces:**
- Consumes: `MasterCv`, `loadMasterCv` (Tasks 2-3); `tailoredCv` (Task 4); `fitsPromptBudget`, `RunOptions.masterCv`, `DraftResponse.cv` (Task 5); `CvRenderer`, `createCvRenderer`, `renderCvHtml`, `tailoredCvPath` (Task 6); `persist(…, cvPath)` (Task 7); fixtures `master()`, `tailored()` (Task 4), `profile` (Task 6).
- Produces:

```ts
export interface Attachment { path: string, tailored: boolean, note: string }
export async function applicationAttachment(input: {
  master: MasterCv | null
  raw: unknown
  profile: Profile
  cvPath: string
  recruiterEmail: string
  renderer: CvRenderer
}): Promise<Attachment>
```

- [ ] **Step 1: Write the failing tests** — add `import { applicationAttachment } from '../server/utils/cv-attach.ts'` to `test/cv.test.ts`, then append:

```ts
const fakeRenderer = (failWith?: string) => {
  const written: string[] = []
  return {
    written,
    renderer: {
      render: async (_html: string, outPath: string) => {
        if (failWith) throw new Error(failWith)
        written.push(outPath)
        return 1234
      },
      close: async () => {}
    }
  }
}

const attach = (over: Partial<Parameters<typeof applicationAttachment>[0]>) =>
  applicationAttachment({
    master: master(),
    raw: tailored(),
    profile,
    cvPath: 'data/cv/My-CV.pdf',
    recruiterEmail: 'hr@acme.sa',
    renderer: fakeRenderer().renderer,
    ...over
  })

test('a CV that passes every rule is rendered and attached under the uploaded filename', async () => {
  const { renderer, written } = fakeRenderer()
  const a = await attach({ renderer })
  assert.equal(a.tailored, true)
  assert.equal(a.path, join('data', 'cv', 'tailored', 'hr_acme_sa', 'My-CV.pdf'))
  assert.deepEqual(written, [a.path])
  assert.match(a.note, /^cv: tailored/)
})

test('every failure attaches the uploaded PDF, and says why', async () => {
  const outOfOrder = tailored()
  outOfOrder.roles.reverse()
  const cases: [Awaited<ReturnType<typeof applicationAttachment>>, RegExp][] = [
    [await attach({ master: null }), /no master CV/],
    [await attach({ raw: undefined }), /no cv block/],
    [await attach({ raw: outOfOrder }), /rule 1/],
    [await attach({ renderer: fakeRenderer('chrome is gone').renderer }), /render failed: chrome is gone/]
  ]
  for (const [a, why] of cases) {
    assert.equal(a.path, 'data/cv/My-CV.pdf')
    assert.equal(a.tailored, false)
    assert.match(a.note, why)
  }
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/cv.test.ts`
Expected: FAIL — `Cannot find module '…/server/utils/cv-attach.ts'`.

- [ ] **Step 3: Implement** — create `server/utils/cv-attach.ts`:

```ts
// Which PDF an email carries, and the one log line that says why. Anything short of a checked, rendered
// tailored CV attaches the uploaded PDF: tailoring may cost quality, never an email.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md, section 5.
import type { Profile } from '../../shared/settings.ts'
import type { MasterCv } from './cv-master.ts'
import { renderCvHtml, tailoredCvPath, type CvRenderer } from './cv-render.ts'
import { tailoredCv } from './cv-tailor.ts'

export interface Attachment {
  /** Repo-relative path to attach. */
  path: string
  /** True only when `path` is a tailored CV — it is then recorded on contacts.cv_path, and null otherwise. */
  tailored: boolean
  note: string
}

export async function applicationAttachment(input: {
  master: MasterCv | null
  raw: unknown
  profile: Profile
  cvPath: string
  recruiterEmail: string
  renderer: CvRenderer
}): Promise<Attachment> {
  const original = (why: string): Attachment => ({ path: input.cvPath, tailored: false, note: `cv: original — ${why}` })
  if (!input.master) return original('no master CV')
  if (input.raw === undefined) return original('the drafter returned no cv block')

  const checked = tailoredCv(input.raw, input.master)
  if (!checked.ok) return original(checked.reason)

  const out = tailoredCvPath(input.cvPath, input.recruiterEmail)
  try {
    const bytes = await input.renderer.render(renderCvHtml(checked.cv, input.profile), out)
    return { path: out, tailored: true, note: `cv: tailored (${bytes} bytes)` }
  } catch (e) {
    return original(`render failed: ${(e as Error).message}`)
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/cv.test.ts`
Expected: PASS, 29 tests.

- [ ] **Step 5: Record the attached CV on local drafts** — in `server/utils/drafts.ts`, add to `interface StoredDraft`, after `gaps: string[]`:

```ts
  /** The CV this draft would attach. Absent on drafts written before tailoring existed. */
  cv?: string
```

- [ ] **Step 6: Wire the job** — in `server/utils/jobs.ts`:

Change the drafter import and add three:

```ts
import { applicationAttachment } from './cv-attach'
import { loadMasterCv, type MasterCv } from './cv-master'
import { createCvRenderer } from './cv-render'
import { fitsPromptBudget, runDrafter, type DraftPost, type DraftRequest, type DraftResponse } from './drafter'
```

In `runDraftJob`, change

```ts
  const { db, close } = openWritableDb()
  try {
```

to

```ts
  const { db, close } = openWritableDb()
  // launches nothing until the first tailored CV is rendered
  const renderer = createCvRenderer()
  try {
```

and the function's closing

```ts
  } finally {
    close()
  }
```

to

```ts
  } finally {
    await renderer.close()
    close()
  }
```

Immediately before the loop `for (const [email, posts] of groups) {`, insert:

```ts
    // Tailoring, when switched on. The master CV loads once per job, and a failure only means this job
    // attaches the uploaded PDF — it must never stop a draft. The prompt budget is per job too: the master
    // CV and the config are both fixed for its duration.
    let master: MasterCv | null = null
    if (config.tailorCv) {
      try {
        master = await loadMasterCv(config.cv)
        if (!fitsPromptBudget(config, master)) {
          push('cv: master CV not injected — the prompt would exceed PROMPT_BUDGET; attaching the uploaded PDF')
          master = null
        }
      } catch (e) {
        push(`cv: master CV unavailable (${(e as Error).message}); attaching the uploaded PDF`)
      }
    }
    let tailoredCount = 0
    let fellBack = 0
```

Change the drafter call to pass the master CV:

```ts
        res = await runDrafter(req, config, { onLog: push, signal, masterCv: master })
```

Replace the block from `const carrier = res.results.find(r => r.body)` down to and including `const { drafted, skipped } = persist(db, req, res, ref)` with:

```ts
      const carrier = res.results.find(r => r.body)
      let ref: string | null = null
      let where = ''
      let tailoredPath: string | null = null
      if (carrier?.body) {
        const sig = signature(config.profile)
        const attachment = config.tailorCv
          ? await applicationAttachment({
              master, raw: res.cv, profile: config.profile, cvPath: config.cv, recruiterEmail: email, renderer
            })
          : null
        if (attachment) {
          push(`${email}: ${attachment.note}`)
          if (attachment.tailored) {
            tailoredCount++
            tailoredPath = attachment.path
          } else {
            fellBack++
          }
        }
        const attachPath = attachment?.path ?? config.cv
        // A Gmail draft when connected, a local file when not, so M1-M3 stay usable without Google Cloud.
        // Either way nothing is sent: the server has no code path that can send.
        if (gmailStatus().authorized) {
          const created = await createDraft({
            to: email,
            cc: cc.join(', ') || undefined,
            subject: carrier.subject,
            text: `${carrier.body}\n\n${sig}`,
            html: renderHtml(carrier.body, sig)
          }, attachPath)
          ref = created.id
          where = ` -> gmail draft ${created.id}${created.attachedBytes ? `, CV ${created.attachedBytes} bytes` : ', NO CV ATTACHED'}`
        } else {
          const file = writeDraftFile({
            recruiterEmail: email,
            cc,
            mode: 'apply',
            subject: carrier.subject ?? null,
            body: carrier.body,
            signature: sig,
            keys: res.results.filter(r => r.verdict === 'drafted').map(r => r.key),
            gaps: carrier.gaps_declared ?? [],
            cv: attachPath,
            createdAt: new Date().toISOString()
          })
          ref = file
          where = ` -> ${file.replace(process.cwd() + '/', '')}`
        }
      }

      const { drafted, skipped } = persist(db, req, res, ref, tailoredPath)
```

Immediately before the loop's following `return 0`, insert:

```ts
    if (config.tailorCv) push(`cv: ${tailoredCount} tailored, ${fellBack} fell back`)
```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0. `jobs.ts` is wiring over tested units; `typecheck` covers `server/`, and Task 10's live run exercises it end to end.

- [ ] **Step 8: Commit**

```bash
git add server/utils/cv-attach.ts server/utils/jobs.ts server/utils/drafts.ts test/cv.test.ts
git commit -m "Attach a tailored CV to each application, and the uploaded PDF on any failure

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The follow-up reuses the application's CV

**Files:**
- Modify: `server/utils/cv-attach.ts` (add `followUpAttachment`)
- Modify: `server/utils/sync.ts` (`draftFollowUp`)
- Test: `test/cv.test.ts`

**Interfaces:**
- Consumes: `contacts.cv_path` (Task 7).
- Produces: `export function followUpAttachment(stored: string | null, cvPath: string, exists?: (path: string) => boolean): string`

- [ ] **Step 1: Write the failing test** — add `followUpAttachment` to the `cv-attach.ts` import in `test/cv.test.ts`, then append:

```ts
test('a follow-up reuses the tailored CV its application carried, while that file still exists', () => {
  assert.equal(followUpAttachment('data/cv/tailored/x/cv.pdf', 'data/cv/cv.pdf', () => true), 'data/cv/tailored/x/cv.pdf')
  assert.equal(followUpAttachment('data/cv/tailored/x/cv.pdf', 'data/cv/cv.pdf', () => false), 'data/cv/cv.pdf')
  assert.equal(followUpAttachment(null, 'data/cv/cv.pdf', () => true), 'data/cv/cv.pdf')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/cv.test.ts`
Expected: FAIL — `does not provide an export named 'followUpAttachment'`.

- [ ] **Step 3: Implement** — in `server/utils/cv-attach.ts`, add `import { existsSync } from 'node:fs'` at the top, and append:

```ts
/**
 * The CV a follow-up carries: the one its application carried, while that file still exists, and the
 * uploaded PDF otherwise. The follow-up says "CV attached again" — a different CV would contradict it.
 */
export function followUpAttachment(
  stored: string | null,
  cvPath: string,
  exists: (path: string) => boolean = existsSync
): string {
  return stored && exists(stored) ? stored : cvPath
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/cv.test.ts`
Expected: PASS, 30 tests.

- [ ] **Step 5: Wire the follow-up** — in `server/utils/sync.ts`, add the import:

```ts
import { followUpAttachment } from './cv-attach'
```

In `draftFollowUp`, immediately before `const created = await createDraft(`, insert:

```ts
  // The CV the application carried, while tailoring is on. Switching tailoring off is the rollback lever,
  // so it returns follow-ups to the uploaded PDF too, not only new applications.
  const sentCv = (db.prepare('SELECT cv_path FROM contacts WHERE email = ?')
    .get(email.toLowerCase()) as { cv_path: string | null } | undefined)?.cv_path ?? null
  const attachPath = config.tailorCv ? followUpAttachment(sentCv, config.cv) : config.cv
```

and in that `createDraft(...)` call, replace the second argument `config.cv,` with:

```ts
    attachPath,
```

- [ ] **Step 6: Run everything, then commit**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0.

```bash
git add server/utils/cv-attach.ts server/utils/sync.ts test/cv.test.ts
git commit -m "Send the follow-up with the same CV its application carried

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Invariants, documentation and the live run

**Files:**
- Modify: `test/invariants.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the invariants** — append to `test/invariants.test.ts` (it already imports `readFileSync`, `assert` and `test`):

```ts
test('CV rendering never touches the LinkedIn profile: a fresh headless browser, never a persistent one', () => {
  // The draft lane runs alongside the scrape lane, which holds ./profile's lock for the whole scrape. A
  // renderer that opened it would fail every tailored CV during a scrape, or break the scrape itself.
  const src = readFileSync('server/utils/cv-render.ts', 'utf8')
  assert.doesNotMatch(src, /launchPersistentContext|PROFILE_DIR|['"`]\.\/profile/)
  assert.match(src, /headless:\s*true/)
})

test('the drafter keeps the cv block untyped, so a malformed CV can never fail an email', () => {
  const src = readFileSync('server/utils/drafter.ts', 'utf8')
  assert.match(src, /cv:\s*z\.unknown\(\)\.optional\(\)/)
})

test('switching tailoring off returns follow-ups to the uploaded PDF, not only new applications', () => {
  const sync = readFileSync('server/utils/sync.ts', 'utf8')
  const fn = sync.slice(sync.indexOf('async function draftFollowUp'))
  assert.match(fn, /config\.tailorCv\s*\?\s*followUpAttachment\(/)
})
```

- [ ] **Step 2: Run them**

Run: `node --test test/invariants.test.ts`
Expected: PASS. Then prove each can fail: in `cv-render.ts` temporarily change `headless: true` to `headless: false`, confirm the first invariant fails, and revert; in `drafter.ts` temporarily change `z.unknown()` to `z.string()`, confirm the second fails, and revert.

- [ ] **Step 3: Document it** — in `CLAUDE.md`:

Replace the stale bullet beginning `- **The CV PDF is ~1.4 MB**` with:

```markdown
- **The CV PDF is ~56 KB** (measured 2026-09-17: two pages, no images, set in Carlito). Earlier notes said
  ~1.4 MB; that was an older file.
```

In the `## Gmail (M4)` section, after the bullet beginning `- **The CV is attached at creation**`, add:

```markdown
- **A tailored CV, when `tailorCv` is on** (off by default). The PDF is extracted once into a master CV,
  cached in `data/cv/master.json` against its sha256, and every bullet must appear in a verbatim extraction
  of the same PDF or nothing is cached. The drafter returns a `cv` block beside the email, kept
  `z.unknown()` so it can never fail the email, and `tailoredCv()` in `server/utils/cv-tailor.ts` checks it:
  the same roles in date order, each bullet once under its own role, skills renamed never, no new number,
  no technology the master CV does not name, no bullet longer than 1.5× its source plus 20 characters, no
  placeholder. **Any failure attaches the uploaded PDF** — extraction, the prompt budget, the check, or
  rendering — and says why in the job log, with a `cv: N tailored, M fell back` line per job.
  `contacts.cv_path` records a tailored CV sent (null for the uploaded one); the follow-up reuses it.
  Tailored PDFs live in `data/cv/tailored/<recruiter>/` under the uploaded file's own name, because
  `createDraft` names the attachment after the file. Rendering uses a fresh headless Chrome, never
  `./profile`. Tune the template with `node --env-file-if-exists=.env scripts/preview-cv.ts`. Design:
  `docs/superpowers/specs/2026-09-17-tailored-cv-design.md`.
```

- [ ] **Step 4: Run everything**

Run: `npm test && npm run lint && npm run typecheck` — Expected: exit 0.

- [ ] **Step 5: The live run** — with the dev server running (`npm run dev`):
1. Settings: switch on **Tailor the CV to each application**, and Save.
2. Posts: press **Draft** on one post with an email address.
3. The Run view's job log must show one of `cv: tailored (N bytes)` or `cv: original — <reason>`, and a closing `cv: 1 tailored, 0 fell back` (or `0 tailored, 1 fell back`).
4. If it fell back, the reason names a rule and an id. Read it before changing anything: a rule rejecting a genuine rewording is a finding about the rule; a rule rejecting an invented claim is the rule working.
5. Open the Gmail draft. The attachment's filename must equal the uploaded CV's filename. Open it next to the uploaded PDF: same layout, same facts, bullets reordered and reworded.
6. Confirm the record: `node -e "const db=require('better-sqlite3')('data/jobfinder.db');console.log(db.prepare('select email, cv_path from contacts where cv_path is not null').all())"` prints that recruiter with a `data/cv/tailored/...` path.
7. Switch **Tailor** off, Save, draft another post, and confirm the job log carries no `cv:` lines and the attachment is the uploaded PDF.

- [ ] **Step 6: Commit**

```bash
git add test/invariants.test.ts CLAUDE.md
git commit -m "Pin the tailored CV's safety properties, and document the feature

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
