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
