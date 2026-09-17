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

  try {
    const checked = tailoredCv(input.raw, input.master)
    if (!checked.ok) return original(checked.reason)
    const out = tailoredCvPath(input.cvPath, input.recruiterEmail)
    const bytes = await input.renderer.render(renderCvHtml(checked.cv, input.profile), out)
    return { path: out, tailored: true, note: `cv: tailored (${bytes} bytes)` }
  } catch (e) {
    // Nothing that happens here may cost an email: jobs.ts calls this outside the try that guards the
    // drafter, so an escaping throw would end the whole batch, not just this recruiter's CV.
    return original(`cv step failed: ${(e as Error).message}`)
  }
}
