# Making Job Finder usable by anyone: a generated application profile

*2026-09-13. Implemented on `nuxt-rewrite`.*

## The problem

The tool was one person's by construction, and the worst of it was not the documentation — it was a
prompt. `.claude/skills/job-application-drafter/SKILL.md` was **live code**: `server/utils/drafter.ts`
read it off disk and concatenated it into `--append-system-prompt` for every draft. It carried named
employers, named projects with URLs, a nine-bullet list of one person's gaps, and this:

```
`<Role> — Ada Lovelace | <two or three differentiators that match their asks>`
                ^^^^^^^^^^^^ one person's real name, spelled out, in a file every install loaded
```

*(the name is substituted here — `test/identity.test.ts` rejects the real one, which is the point)*

`drafter.ts` takes the model's `subject` verbatim and nothing post-processes it. So a second person
who cloned the repo and filled in Settings perfectly still got application emails carrying someone
else's name in the subject line and claiming someone else's projects.

Two sibling defects were found in the same file: line 196 asserted "he can start immediately"
unconditionally, contradicting `profileBlock`'s `canStartImmediately` branch; line 96 told the model
to "state the actual Cairo window" while the window itself was injected.

## Scope, as decided with the owner

| Question | Decision |
|---|---|
| Sharing model | **Single-tenant.** Each person clones and runs their own copy. `CHECK (id = 1)` stays; no auth, no accounts. |
| Field scope | **Any job seeker, any field** — not just any frontend developer. |
| Profile content | **AI-generated from the CV plus the user's target titles, reviewed before saving.** |
| Release prep | **In scope**: scrub the specs, write a README, widen the identity invariants. |

## The approach: one seam, no templating language

`buildSystemPrompt` already composed half this prompt from data — `profileBlock(config)` built
identity and constraints from the settings row. The skill file was simply the half that never moved.
So the pattern was extended rather than replaced:

```
buildSystemPrompt(config) = candidateBlock(config) + '\n\n---\n\n' + readProcedure()

candidateBlock = profileBlock + scopeBlock + evidenceBlock + gapsBlock + strengthsBlock
```

**No `{{mustache}}`.** The procedure file has zero substitution points, which is what makes the
property testable as a static fact: it contains no person-specific bytes at all. A templating scheme
would only have that property *after* rendering, and a missed placeholder ships literal braces to a
recruiter while a missing injected section is a visible absence the model can report.

The file moved to `server/prompts/drafter-procedure.md`. `.claude/skills/` was wrong twice over: the
drafter spawns in an empty cwd so the CLI never discovered it as a skill anyway, and all it achieved
was making a server data file appear as an interactive skill — described in terms of one person — in
every Claude session opened in this repo.

## The data

Two new settings blocks, split along the line that already existed between the two consumers:

- **`scope`** — `roleFamily`, `primarySkills`, `secondarySkills`, `excludedRoles`, `seniorityFloor`.
  Read by the scorer, the pre-screen *and* the drafter. Replaces `constraints.stackWeighting`, whose
  `vue-primary | equal | react-primary` enum could only ever describe one trade.
- **`background`** — `evidence`, `gaps`, `strengths`, `neverClaim`. Read by the drafter only.

`evidence` is prose because its structure is nested — roles, then work, then the tools attached to
each piece of work — and flattening it loses the grouping that stops the model attributing one
project's tools to another. `gaps` is a **list**, because each entry is an atomic claim the user must
be able to delete on its own; that per-item review is the defence against a generated gap nobody has.

Deep structure was rejected: `stack: string[]` is a software-only idea, and "any profession" is the
requirement that kills it. A nurse's evidence is caseloads and registrations.

**No pronoun field.** The ~40 `he/him/his` in the old file were all *instructions about* the
candidate — emails are written in the first person — so "the candidate" replaces every one, costs no
setting, and removes any way to get someone's pronouns wrong.

## Gaps are a projection, never a field the model writes

This is the load-bearing idea. Evidence is extraction and is safe: you ask what a document says. Gaps
are **absences**, and "what does this CV lack?" is an open question with no closed universe, so a
model answers it by inventing something plausible. An invented gap is worse than a missed one — it
makes every future application apologise for a weakness the person does not have.

So the model never writes gaps. It fills a verdict **table** — one row per requirement, each carrying
`requirement`, `askedForBy`, `status` (present/partial/absent), `cvShows` and `sentence` — and
`gapsFrom()` in `shared/background.ts` projects the gaps out of it, discarding any row it cannot
justify:

- attributed to a title the user does not actually target
- an `absent` row that quotes the CV, or a `partial` row that quotes nothing (self-contradictions)
- a sentence in quotation marks — the drafter reuses such a sentence verbatim in a real email, so it
  must come from the person, not the model
- duplicates, and anything past the cap

To invent a gap the model must therefore also invent a requirement *and* pin it to one of the user's
own titles, and that attribution is checked in code rather than asked for in prose. Discarded rows
are returned to the page rather than swallowed, because a rising count is how you notice drift.

The universe is the user's `titles`, so the endpoint refuses outright on an empty list rather than
degrading.

## Measured findings

**The generator needs a stronger model than the scorer.** On one real CV with this exact prompt:

| model | requirements | gaps |
|---|---|---|
| `gpt-5-nano` | **0** | 0 |
| `gpt-5-mini` | **17** (14 present, 2 partial, 1 absent) | 3, none discarded |

Nano is not weak at extraction — on the same run it produced good evidence and caught every
unverified `~NN%` estimate on the CV. It cannot hold a seventeen-row judgement table, and it fails
**silently**: an empty `requirements` array is valid against the strict schema, so the endpoint
returns 200 with no gaps and the honesty mechanism is simply absent. Hence
`JOBFINDER_BACKGROUND_MODEL`, defaulting to `gpt-5-mini`, plus a warning when the table comes back
empty. Justified because this call runs once per CV behind human review, unlike the scoring model,
which runs per post.

The three gaps `gpt-5-mini` generated independently matched the hand-curated ones (no backend
Node.js, no budget or hiring scope, no cloud/CI-CD).

**A residency gate is only a gate somewhere you do not live.** `FLAG_RULES['residency-gate']`
hardcoded Gulf state names. The obvious generalisation — derive them from `onsiteCountries` — is
wrong: that list is by definition where the user *would* work, including where they live, so
"Egypt-based candidates only" would have flagged every posting in their own city. The rule derives
from `onsiteCountries + willRelocate` **minus the home country**, resolved from `profile.location`,
and emits no country clause at all when the home country cannot be resolved. Flags remove a post from
the drafter queue outright, so every derived rule fails open.

Country matching is by **alpha-2 code, not display name** — the display name for the US is `USA`, and
comparing prose failed silently, leaving the rule firing for people living in that region.

Measured against the stored corpora after the change: `seeking-work` still fires on exactly the three
seeker rows of `backups/pre-wipe-2026-09-13.db`; `night-shift`, `junior` and `junior-years` are
unchanged; `wordpress-only` is gone by design; and the derived `residency-gate` newly catches
"South African Citizens Only!", which the Gulf-only regex missed.

## Two gates, not one

`readConfig()` turned out to have exactly two callers, both in the draft/sync path — the scrape path
has **no config gate at all**, and the scraper reads settings itself, falling back to
`emptySettings()`. So evidence could not simply be added to `missingFields()`.

- `missingFields()` — unchanged meaning: what stops a scrape.
- `missingForDrafting()` — evidence. `readConfigForDraft()` calls it, wired into `runDraftJob` only;
  `runSyncJob` keeps the looser gate because the sweep reads sent mail and makes no new claims.
- `settingsWarnings()` — non-blocking. An empty `gaps` list warns loudly rather than blocking: a
  required field people satisfy with junk is worse than an unrequired one.

## What enforces it

`test/identity.test.ts` replaces a scan that matched three literals over `server/` + `shared/` — one
of which was the previous owner's company domain, so the guard against hardcoded identities hardcoded
one. Two checks replace it:

1. **Derived needles.** The owner's name, name tokens, email, local part, LinkedIn and GitHub handles
   and phone digits are read from the *live settings row* and asserted absent from every file that
   would be committed (`git ls-files --cached --others --exclude-standard`). It needs no name in the
   test, works for whoever owns the install, and skips on a fresh clone. Verified by planting the
   name in CLAUDE.md: the test fails, and passes again on revert.
2. **Shape scan.** Email, phone, LinkedIn and GitHub *shapes* over `server/`, `shared/`, `scraper/`
   and `app/` — catching a stranger's details as well as your own, and `@outlook.com`, which the old
   literal set missed.

Plus: the procedure file must contain no pronoun and must actually refer to each injected section; a
two-fixture differential asserts that two different candidates produce prompts whose procedure halves
are byte-identical and which carry none of each other's identity; and a source-text invariant asserts
`runDraftJob` gates on `readConfigForDraft`, because `missingForDrafting()` existed with no consumer
for one commit while the UI already claimed drafting was blocked.

## Known limits

- The differential test guards *identity*. It would not have caught SKILL.md's "he can start
  immediately" or "the Cairo window" — those are constraint re-assertions, which carry no name. The
  rule no test can enforce is stated in the procedure's own header: **it may reference an injected
  value, never state one.**
- Git history still holds the real phone number, email and the old SKILL.md with its CV evidence, in
  every commit up to `63aed17`, which is already pushed to a repository the owner does not own.
  Scrubbing the working tree does not change that.
