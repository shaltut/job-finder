// The tailored CV, tested without a model, a browser or a database: ids, the PDF-text match, the seven
// rules, rendering and the attachment decision. See docs/superpowers/specs/2026-09-17-tailored-cv-design.md.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MASTER_CACHE_VERSION, assignIds, loadMasterCv, masterCvBlock, matchKey, missingBullets, pdfSha256, toContent, type CvContent, type Extractor } from '../server/utils/cv-master.ts'
import { tailoredCv } from '../server/utils/cv-tailor.ts'
import { emptySettings } from '../shared/settings.ts'
import { createCvRenderer, renderCvHtml, tailoredCvPath } from '../server/utils/cv-render.ts'
import { applicationAttachment, followUpAttachment } from '../server/utils/cv-attach.ts'

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
  achievements: ['Cut cloud spend 30% by consolidating three billing pipelines.'],
  personalDetails: ['Date of Birth: 1 January 1990'],
  interests: ['Reading', 'Football'],
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

test('a cache written under an older MasterCv shape is a miss, not a wrong answer', async () => {
  // The PDF's bytes do not change when the schema does, and the hash is all the key used to be. Three
  // fields joined MasterCv mid-branch; a cache predating them makes masterText throw on every draft, so
  // tailoring silently stops until the file is deleted by hand. The version is what makes it a miss.
  const s = scratch('%PDF-1.4 one')
  try {
    const { extractor, calls } = fakeExtractor()
    await loadMasterCv(s.pdf, extractor, s.cache)
    const stale = JSON.parse(readFileSync(s.cache, 'utf8'))
    assert.equal(stale.version, MASTER_CACHE_VERSION)
    delete stale.version
    writeFileSync(s.cache, JSON.stringify(stale))
    await loadMasterCv(s.pdf, extractor, s.cache)
    assert.equal(calls.extract, 2, 'an unversioned cache must be re-extracted, not served')
    writeFileSync(s.cache, JSON.stringify({ ...stale, version: MASTER_CACHE_VERSION + 1 }))
    await loadMasterCv(s.pdf, extractor, s.cache)
    assert.equal(calls.extract, 3, 'a cache from a future shape must be re-extracted too')
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
  assert.deepEqual(r.cv.achievements, content().achievements)
  assert.deepEqual(r.cv.personalDetails, content().personalDetails)
  assert.deepEqual(r.cv.interests, content().interests)
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

test('the summary is held to rules 4, 5, 6 and 7 — rule 5 against the whole master CV', () => {
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

test('the summary may only re-use numbers from the summary and the role dates, never a date of birth', () => {
  // The summary is the most claim-dense field and the first thing a recruiter reads. Drawing its allowed
  // numbers from the whole master CV let a digit sitting in a date of birth, a graduation year or an
  // achievement travel out of that field and into a years-of-experience claim, which is the one lie the
  // seven rules exist to stop. "11" appears nowhere in this CV but the date of birth.
  const cv = content()
  cv.personalDetails = ['Date of Birth: 11 May 1985']
  const t = tailored()
  t.summary = 'Backend engineer with 11 years building payment systems on .NET and PostgreSQL.'
  const r = tailoredCv(t, assignIds(cv))
  assert.equal(r.ok, false, 'expected a rejection')
  if (!r.ok) assert.match(r.reason, /^rule 4 at summary: "11"/)
})

test('rule 6 covers the summary too, not bullets alone', () => {
  // Master vocabulary only, so rules 4 and 5 — which run first — have nothing to catch: length is the
  // only thing left to reject it. Without a limit the summary could run to any length the model liked.
  const t = tailored()
  t.summary = 'Backend engineer with 9 years delivering payment systems on .NET and PostgreSQL. '.repeat(3)
  const r = tailoredCv(t, master())
  assert.equal(r.ok, false, 'expected a rejection')
  if (!r.ok) assert.match(r.reason, /^rule 6 at summary/)
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
  assert.ok(html.includes(content().achievements[0]!), 'the achievements section must render')
  assert.ok(html.includes(content().personalDetails[0]!), 'the personal details section must render')
  assert.ok(html.includes(content().interests[0]!), 'the interests section must render')
  assert.match(html, /font-family:\s*Carlito, Calibri, sans-serif/)
})

test('a tailored CV keeps the uploaded filename, in a folder of its own per recruiter', () => {
  // createDraft names the attachment basename(path), so this filename is what the recruiter sees
  const p = tailoredCvPath('data/cv/My-CV.pdf', 'HR@Acme.sa')
  assert.equal(join(p, '..', '..'), join('data', 'cv', 'tailored'))
  assert.equal(basename(p), 'My-CV.pdf')
  assert.match(basename(dirname(p)), /^hr_acme_sa-[0-9a-f]{8}$/)
  // case-insensitive, or one recruiter would own two folders and the follow-up could miss its own file
  assert.equal(tailoredCvPath('data/cv/My-CV.pdf', 'hr@acme.sa'), p)
})

test('two recruiters never share a tailored-CV folder, however alike their addresses slug', () => {
  // slug() collapses every non-alphanumeric run to "_", so these three are one folder without the hash —
  // and the second render overwrites the file contacts.cv_path recorded for the first, whose follow-up
  // then attaches a CV tailored for the wrong job. All three spellings are ordinary at one agency.
  const of = (email: string) => dirname(tailoredCvPath('data/cv/My-CV.pdf', email))
  const folders = ['a.b@x.com', 'a-b@x.com', 'a_b@x.com'].map(of)
  assert.equal(new Set(folders).size, 3, folders.join(' '))
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

test('a role with no employer renders no stray separator', () => {
  // The extraction returns an empty string for a field the CV does not have, and a hard-coded " — "
  // between title and employer then prints a dash with nothing after it.
  const cv = content()
  cv.roles[0]!.employer = ''
  const html = renderCvHtml(cv, profile)
  assert.equal(html.includes('Engineering Manager — <'), false)
  assert.match(html, /<span>Engineering Manager<\/span>/)
})

test('a control character in the extraction never reaches the master CV', () => {
  // Extraction reads a PDF's text layer, which carries stray control characters — a stable \x0E showed up
  // in the summary on every attempt against the real CV. matchKey strips them before comparing and
  // missingBullets only covers bullet text, so nothing else would catch one before it reached the PDF.
  const cv = content()
  cv.summary = 'Backend engineer\u000E with 9 years on .NET.'
  cv.roles[0]!.bullets[0] = 'Led a team of 12\u200B engineers across backend and DevOps.'
  cv.interests = ['Reading\u0008']
  const m = assignIds(cv)
  assert.equal(m.summary, 'Backend engineer with 9 years on .NET.')
  assert.equal(m.roles[0]!.bullets[0]!.text, 'Led a team of 12 engineers across backend and DevOps.')
  assert.deepEqual(m.interests, ['Reading'])
})

// Built with fromCharCode, never a backslash-u escape: a write path in this repo has twice turned that
// escape text into the raw byte, which still runs and still passes while the source is corrupt.
const CTRL = String.fromCharCode(14) // U+000E, the one the real CV text layer carried
const ZWSP = String.fromCharCode(8203) // U+200B

test('a control character the model emitted never reaches the rendered CV either', () => {
  // The master is cleaned in assignIds; the tailored summary and bullets are model output and were not,
  // so a stray control character passed all seven rules and printed into the PDF a recruiter opens.
  // Cleaning runs before the rules, so it also cannot be used to hide a token from rule 5.
  const t = tailored()
  t.summary = 'Backend engineer with 9 years' + CTRL + ' delivering payment systems on .NET and PostgreSQL.'
  t.roles[0]!.bullets[0]!.text = 'Reduced invoice' + ZWSP + ' generation latency by 40% by tuning query plans.'
  const r = tailoredCv(t, master())
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.equal(r.cv.summary, 'Backend engineer with 9 years delivering payment systems on .NET and PostgreSQL.')
  assert.equal(r.cv.roles[0]!.bullets[0], 'Reduced invoice generation latency by 40% by tuning query plans.')
  assert.equal(renderCvHtml(r.cv, profile).includes(CTRL), false)
})

test('a control character cannot smuggle a technology past rule 5', () => {
  const t = tailored()
  t.roles[1]!.bullets[0]!.text = 'Delivered REST APIs in C# and ASP.NET Core on A' + CTRL + 'WS for a payments integration.'
  const r = tailoredCv(t, master())
  assert.equal(r.ok, false, 'expected a rejection')
  if (!r.ok) assert.match(r.reason, /^rule 5 at r1\.b0: "AWS"/)
})

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
  assert.equal(a.path, tailoredCvPath('data/cv/My-CV.pdf', 'hr@acme.sa'))
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
    [await attach({ renderer: fakeRenderer('chrome is gone').renderer }), /cv step failed: chrome is gone/]
  ]
  for (const [a, why] of cases) {
    assert.equal(a.path, 'data/cv/My-CV.pdf')
    assert.equal(a.tailored, false)
    assert.match(a.note, why)
  }
})

test('a throw anywhere in the CV step attaches the uploaded PDF instead of ending the batch', () => {
  // jobs.ts calls applicationAttachment outside the try that guards the drafter, so an escaping throw
  // would cost every remaining recruiter their email, not just this one's tailored CV.
  const exploding = {
    get summary() {
      throw new Error('boom')
    }
  }
  return attach({ raw: exploding }).then((a) => {
    assert.equal(a.tailored, false)
    assert.equal(a.path, 'data/cv/My-CV.pdf')
    assert.match(a.note, /cv step failed: boom/)
  })
})

test('a follow-up reuses the tailored CV its application carried, while that file still exists', () => {
  assert.equal(followUpAttachment('data/cv/tailored/x/cv.pdf', 'data/cv/cv.pdf', () => true), 'data/cv/tailored/x/cv.pdf')
  assert.equal(followUpAttachment('data/cv/tailored/x/cv.pdf', 'data/cv/cv.pdf', () => false), 'data/cv/cv.pdf')
  assert.equal(followUpAttachment(null, 'data/cv/cv.pdf', () => true), 'data/cv/cv.pdf')
})
