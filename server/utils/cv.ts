// Storing the uploaded CV. The path used to be an absolute one the user typed; it is now a file the
// app owns under data/cv/, which is already gitignored — so the CV never enters the repository and a
// fresh install can be set up entirely through the browser.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

export const CV_DIR = 'data/cv'
export const MAX_CV_BYTES = 10 * 1024 * 1024

/**
 * A filename we chose, never the client's. `basename` alone is not enough: the point is that no
 * input can produce a path outside CV_DIR, so everything but a conservative character set is
 * replaced and the extension is forced.
 */
export function safeCvName(clientName: string): string {
  const stem = basename(clientName, extname(clientName))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return `${stem || 'cv'}.pdf`
}

/** A PDF starts with %PDF-. Checked on the bytes, because the client's content-type is a claim. */
export function isPdf(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 5)).toString('latin1') === '%PDF-'
}

/**
 * Writes the CV and returns its repo-relative path. Older PDFs in the directory are removed after
 * the new one lands: this is a replace, and 1.4 MB files accumulating under a name nothing points at
 * is just litter.
 */
export function storeCv(clientName: string, data: Uint8Array): { path: string, bytes: number } {
  const name = safeCvName(clientName)
  const dir = resolve(process.cwd(), CV_DIR)
  mkdirSync(dir, { recursive: true })

  const abs = join(dir, name)
  // belt and braces: the sanitiser above should make this impossible, so if it ever fires the
  // sanitiser has a hole and we want to know rather than write outside the directory
  if (resolve(abs) !== join(dir, basename(abs))) {
    throw new Error('refusing to write outside the CV directory')
  }
  writeFileSync(abs, data)

  for (const f of readdirSync(dir)) {
    if (f !== name && f.toLowerCase().endsWith('.pdf')) rmSync(join(dir, f), { force: true })
  }
  return { path: `${CV_DIR}/${name}`, bytes: data.length }
}

export function cvExists(p: string): boolean {
  return !!p && existsSync(resolve(process.cwd(), p))
}
