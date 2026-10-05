// Screenshots the running dev server. The Claude-in-Chrome extension cannot open localhost, so this
// drives the installed Chrome headlessly through playwright-core instead.
//
//   npm run dev            # in one terminal
//   node scripts/screenshot.mjs [outDir] [baseUrl]
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const out = process.argv[2] || 'logs/shots'
const base = process.argv[3] || 'http://127.0.0.1:3939'
const views = [['posts', '/'], ['pipeline', '/pipeline'], ['run', '/run'], ['settings', '/settings'], ['gaps', '/gaps']]

mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

const errors = []
page.on('console', m => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

for (const [name, path] of views) {
  const res = await page.goto(base + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${out}/${name}.png` })
  console.log(`${name.padEnd(9)} ${res?.status()}  ${out}/${name}.png`)
}

console.log(errors.length ? `\nCONSOLE ERRORS (${errors.length}):\n${errors.slice(0, 10).join('\n')}` : '\nno console errors')
await browser.close()
process.exit(errors.length ? 1 : 0)
