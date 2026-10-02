// The recruiter's stage as the Posts view shows it: `contacts.stage` for the post's first address, the
// same recruiter the drafter groups by. Pure and import-free, like paste-poll.ts, so a node:test file can
// exercise it — there is no Vue test setup in this repo.

export type Stage = 'drafted' | 'contacted' | 'followed_up' | 'replied' | 'final'

export const STAGE_LABEL: Record<Stage, string> = {
  drafted: 'Draft pending',
  contacted: 'Contacted',
  followed_up: 'Followed up',
  replied: 'Replied',
  final: 'Final'
}

/**
 * True when Gmail already holds mail for this recruiter — sent, bounced or answered — so the draft gate
 * (closedBy in server/utils/stages.ts) can only refuse, and a Draft button would do nothing but decline.
 * `drafted` is the exception: a pending draft deleted unsent reopens the recruiter, and only the gate,
 * which asks Gmail, can see that. The cache here cannot.
 */
export const sentTo = (stage: Stage | null | undefined): boolean => !!stage && stage !== 'drafted'
