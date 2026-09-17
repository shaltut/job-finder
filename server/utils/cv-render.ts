// Printing a CV: an HTML template modelled on the uploaded two-page layout, printed to PDF by headless
// Chrome. No templating dependency — a string, with every value escaped.
// See docs/superpowers/specs/2026-09-17-tailored-cv-design.md, section 4.
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Browser } from 'playwright-core'
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
header { margin-bottom: 10pt; text-align: center; }
h1 { font-size: 20pt; margin: 0; color: #1b3a5c; }
.title { font-size: 11.5pt; margin: 2pt 0 4pt; color: #333; }
.contact { font-size: 9.5pt; color: #333; }
h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: .04em; color: #1b3a5c;
  border-bottom: 1px solid #1b3a5c; margin: 10pt 0 4pt; padding-bottom: 1pt; }
.role { margin-bottom: 6pt; }
.role-head { display: flex; justify-content: space-between; gap: 8pt; font-weight: bold; }
.role-meta { font-style: italic; font-weight: normal; }
/* list-style: none — the extraction keeps each bullet's own leading glyph verbatim (by design, so the
   PDF-text match in cv-master.ts can verify it unchanged), so a browser marker on top of it doubles the dot. */
ul { list-style: none; margin: 2pt 0 0 2pt; padding: 0; }
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
    `<div class="role-head"><span>${[r.title, r.employer].filter(Boolean).map(esc).join(' — ')}</span>`,
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
    section('Achievements', list(cv.achievements)),
    section('Skills', skills ? `<div class="skills">${skills}</div>` : ''),
    section('Experience', roles),
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
  launch: () => Promise<Browser> = async () => {
    // Lazy: the server loads playwright-core only when a tailored CV is actually rendered, so with
    // tailoring switched off — the default — it is never loaded at all.
    const { chromium } = await import('playwright-core')
    return chromium.launch({ channel: 'chrome', headless: true })
  }
): CvRenderer {
  let browser: Promise<Browser> | null = null
  return {
    render: async (html, outPath) => {
      browser ??= launch()
      const page = await (await browser).newPage()
      try {
        await page.setContent(html, { waitUntil: 'load' })
        // awaited inside the page: returning the FontFaceSet itself would make Playwright serialise it.
        // `document` only exists in the page's browser realm, not this file's Nitro/Node typecheck lib
        // (no "dom" — see .nuxt/tsconfig.server.json), so it is reached through globalThis, cast past it.
        await page.evaluate(async () => {
          await (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready
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
