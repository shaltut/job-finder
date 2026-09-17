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
