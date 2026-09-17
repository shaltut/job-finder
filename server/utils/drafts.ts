// Turns a drafter response into rows and files. In M3 the email is written to data/drafts/ for you to read
// and copy; M4 swaps `deliver` for a Gmail drafts.create call with the CV attached. Everything else here —
// the verdict rows, the recruiter stage, the two-emails-ever ceiling — is unchanged by that swap.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import type { DraftRequest, DraftResponse } from './drafter'

export const DRAFTS_DIR = resolve(process.cwd(), 'data/drafts')

export interface StoredDraft {
  recruiterEmail: string
  /** Optional: drafts written before the Cc fix have no such key and must still parse. */
  cc?: string[]
  mode: 'apply' | 'follow-up'
  subject: string | null
  body: string
  signature: string
  keys: string[]
  gaps: string[]
  createdAt: string
}

/** Filenames must round-trip an email address safely. */
const slug = (email: string) => email.toLowerCase().replace(/[^a-z0-9]+/g, '_')

/**
 * The signature the skill is told not to write. Kept here so it is identical on every draft and so the
 * links survive: Gmail rewrites bare URLs in a plain-text body into google.com/url?q= redirects, so M4
 * renders these as real anchors in the HTML part.
 */
export function signature(profile: { name: string, title: string, phone: string, email: string, linkedin: string, github: string }): string {
  return [
    profile.name,
    profile.title,
    profile.phone,
    profile.email,
    profile.linkedin,
    profile.github
  ].filter(Boolean).join('\n')
}

export function writeDraftFile(d: StoredDraft): string {
  mkdirSync(DRAFTS_DIR, { recursive: true })
  const file = join(DRAFTS_DIR, `${slug(d.recruiterEmail)}${d.mode === 'follow-up' ? '.follow-up' : ''}.json`)
  writeFileSync(file, JSON.stringify(d, null, 2) + '\n')
  return file
}

export function listDrafts(): StoredDraft[] {
  try {
    return readdirSync(DRAFTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(DRAFTS_DIR, f), 'utf8')) as StoredDraft)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

/**
 * Records every verdict and moves the recruiter's stage, in one transaction so a crash cannot leave a
 * draft on disk with no row behind it.
 *
 * The contacts upsert carries `WHERE contacts.stage <> 'final'`: a recruiter who has had their two emails
 * is never contacted again, and that is enforced by the database rather than by prose.
 */
export function persist(
  db: Database.Database,
  req: DraftRequest,
  res: DraftResponse,
  draftFile: string | null
): { drafted: number, skipped: number } {
  const now = Math.floor(Date.now() / 1000)
  let drafted = 0
  let skipped = 0

  const tx = db.transaction(() => {
    for (const r of res.results) {
      db.prepare(`
        INSERT INTO applications (key, verdict, reason, recruiter_email, gmail_draft_id, created_at)
        VALUES (@key, @verdict, @reason, @email, @draftId, @now)
        ON CONFLICT (key) DO UPDATE SET
          verdict = excluded.verdict,
          reason = excluded.reason,
          gmail_draft_id = excluded.gmail_draft_id
      `).run({
        key: r.key,
        verdict: r.verdict,
        reason: r.reason,
        email: req.recruiterEmail,
        // in M3 this column holds the local file; M4 replaces it with the real Gmail draft id
        draftId: r.verdict === 'drafted' ? draftFile : null,
        now
      })
      if (r.verdict === 'drafted') drafted++
      else skipped++
    }

    // Only a real email moves the recruiter's stage. An all-skipped recruiter gets no contacts row at all.
    if (drafted > 0) {
      const stage = req.mode === 'follow-up' ? 'followed_up' : 'drafted'
      db.prepare(`
        INSERT INTO contacts (email, stage, note, updated_at)
        VALUES (@email, @stage, @note, @now)
        ON CONFLICT (email) DO UPDATE SET
          stage = excluded.stage, note = excluded.note, updated_at = excluded.updated_at
        WHERE contacts.stage <> 'final'
      `).run({
        email: req.recruiterEmail.toLowerCase(),
        stage,
        note: draftFile ? `draft written to ${draftFile}` : null,
        now
      })
    }
  })

  tx()
  return { drafted, skipped }
}

/** True when this recruiter must not be emailed again. */
export function isClosed(db: Database.Database, email: string): false | string {
  const row = db.prepare('SELECT stage FROM contacts WHERE email = ?').get(email.toLowerCase()) as { stage: string } | undefined
  if (!row) return false
  if (row.stage === 'final') return 'recruiter final'
  if (row.stage === 'replied') return 'recruiter replied'
  if (row.stage === 'drafted') return 'application draft pending'
  if (row.stage === 'followed_up') return 'follow-up draft pending'
  return false
}
