// The tailored CV, tested without a model, a browser or a database: ids, the PDF-text match, the seven
// rules, rendering and the attachment decision. See docs/superpowers/specs/2026-09-17-tailored-cv-design.md.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignIds, loadMasterCv, masterCvBlock, matchKey, missingBullets, pdfSha256, toContent, type CvContent, type Extractor } from '../server/utils/cv-master.ts'
import { tailoredCv } from '../server/utils/cv-tailor.ts'
import { emptySettings } from '../shared/settings.ts'
import { createCvRenderer, renderCvHtml, tailoredCvPath } from '../server/utils/cv-render.ts'

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

test('an id the model merged is a malformed block, never a throw', () => {
  // Ids are compared as joined strings, so an id carrying the separator could pass a structure rule and
  // then throw on the lookup that follows. Every id must have the shape code assigns.
  const mergedBullet = tailored()
  mergedBullet.roles[0]!.bullets = [
    { id: 'r0.b0,r0.b1', text: 'Managed a team of 12 engineers and moved billing to PostgreSQL.' },
    { id: 'r0.b2', text: 'Reduced invoice generation latency by 40% by tuning query plans.' }
  ]
  const mergedSkills = tailored()
  mergedSkills.skills = [{ id: 's0,s1', items: ['C#', '.NET', 'ASP.NET Core', 'PostgreSQL', 'Redis'] }]
  const mergedRoles = tailored()
  mergedRoles.roles = [{ id: 'r0,r1', bullets: mergedRoles.roles[0]!.bullets }]
  for (const raw of [mergedBullet, mergedSkills, mergedRoles]) {
    const r = tailoredCv(raw, master())
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /^malformed cv block/)
  }
})

test('the master CV block gives every bullet its id — in parentheses, never square brackets', () => {
  const block = masterCvBlock(master())
  assert.match(block, /\(r0\.b1\) Migrated the billing service/)
  assert.match(block, /\(s0\) Backend: C# \| \.NET \| ASP\.NET Core/)
  // PLACEHOLDER rejects square brackets, so a copied "[r0.b3]" would cost the email it landed in
  assert.doesNotMatch(block, /\[[rs]\d/)
  // a markdown rule would make PROMPT_SEPARATOR ambiguous
  assert.equal(block.includes('\n\n---\n\n'), false)
})

test('a multi-line extracted value stays on the line of its id, so it can never carry the prompt separator', () => {
  // The extraction is model output. A value returned with line breaks would split an id from its own text
  // in the model's view, and a blank-line rule inside one would put a second separator in the prompt.
  const m = master()
  m.roles[0]!.bullets[0]!.text = 'Led a team of 12 engineers\n\n---\n\nacross backend and DevOps.'
  const block = masterCvBlock(m)
  assert.equal(block.includes('\n\n---\n\n'), false)
  assert.match(block, /\(r0\.b0\) Led a team of 12 engineers --- across backend and DevOps\./)
})

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
