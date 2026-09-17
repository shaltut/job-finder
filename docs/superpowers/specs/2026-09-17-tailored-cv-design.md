# Tailored CV per application — design

**Status: approved design, not yet implemented.** Agreed section by section on 2026-09-17. The reasoning
behind each decision is kept here so it survives implementation.

---

## Context

Today one uploaded PDF, `data/cv/<cv filename>.pdf`, is attached unchanged to every application draft.
`createDraft` in `server/utils/gmail.ts` reads it from disk and verifies the attached byte count. The email
is written for the post; the attachment is not. That makes the CV the most generic part of an otherwise
tailored application.

Measured before designing, because two assumptions turned out wrong:

- **The CV is 56 KB, not the ~1.4 MB CLAUDE.md records.** Two pages, no images, six embedded fonts: a lean,
  text-based PDF. There is no parsing argument for replacing its design.
- **Its fonts are Carlito** (Regular, Bold, Italic) — the open-source, metric-compatible clone of Calibri.
  Both Carlito and Calibri are installed system-wide on this machine.
- `scripts/screenshot.mjs` already launches `chromium.launch({ channel: 'chrome', headless: true })`, so
  headless PDF printing through the installed `playwright-core` is proven here and adds no dependency.
- `gpt-5-nano` satisfied a strict schema by returning an empty table in `background.post.ts`, which is why
  that endpoint defaults to `gpt-5-mini`. Extraction carries the same risk and makes the same choice.

**The governing risk is overclaiming.** A tailored CV that stretches a fact is worse than a generic one: it
is a factual document under the owner's name, travelling beside an email that must agree with it. Every
decision below is shaped by making that failure checkable **in code** rather than trusted to the model —
the reasoning that already put `gateOnPostType()` and `PLACEHOLDER` in code.

## Decisions

| Question | Decision | Why |
|---|---|---|
| How far to tailor | Reorder **and** reword bullets in the post's own terms; same facts only | Where the value is; made safe by section 3 |
| Source of truth | Extract the PDF once into structured content, cached by the PDF's hash; no review step | No ongoing maintenance for the owner |
| Look | Match the current CV: an HTML template printed to PDF by headless Chrome | Already text-based; recruiters already hold it |
| When the check fails | Attach the original PDF — whole-CV fallback | Simple, and can never produce a half-tailored document |
| Where tailoring happens | Inside the existing `claude -p` drafter session | Email and CV written together cannot contradict |
| Unit | One tailored CV per email, i.e. per recruiter group | One email carries one attachment |
| Follow-up | Reuses the application's tailored CV | A differently shaped "CV attached again" reads as inconsistent |

## 1. The cached master CV

**Extraction.** One OpenAI Responses call with the shape of `background.post.ts`: the PDF as `input_file`, a
strict `json_schema`, model `gpt-5-mini` by default, overridable with `JOBFINDER_CV_MODEL` as `JOBFINDER_BACKGROUND_MODEL` is. It returns
`summary`, `roles[{ title, employer, location, start, end, bullets[text] }]`,
`skills[{ group, items[text] }]`, `education`, `certifications`, `languages`.

**Code assigns the ids, never the model** — `r0`, `r0.b3`, `s1`. They anchor every later check, so they must
be deterministic and unique, which a model cannot guarantee.

**Name and contact details come from `settings.profile`, not from extraction.** They are the reviewed
values the email signature already uses, so the CV header and the email cannot disagree about how to reach
the owner.

**Checking the cache against the PDF.** A second call returns the CV as verbatim plain text — the same
instruction the scraper's `loadCv` uses. Code then requires every extracted bullet to appear in that text,
compared after NFKC normalisation (so the `ﬁ` ligature matches `fi`), lowercasing and removing everything
but letters and digits, so line wraps and bullet glyphs cannot cause false failures. A bullet not found
means nothing is cached and the job log names it. This is the defence against extraction inventing or
merging a bullet, since no human reviews the cache.

**The cache** is one gitignored file, `data/cv/master.json`: `{ pdfSha256, extractedAt, model, cv }`. It is
used when its hash matches the current PDF and rebuilt when it does not, so uploading a new CV invalidates it
with no extra code.

**When it runs:** lazily, the first time a draft job needs it, in the draft lane before the `claude` session.
Upload stays instant and there is no new button. Two model calls, once per CV. If extraction fails the job
drafts with the original PDF.

## 2. The drafter's contract

**Placement.** One `cv` block at the top level of the response, beside `results` and `report` — one per
recruiter group, one per email. Apply mode only — hand-picked (`chosen`) drafts included; follow-up mode never
returns one.

```jsonc
"cv": {
  "summary": "…",
  "roles":  [{ "id": "r0", "bullets": [{ "id": "r0.b3", "text": "…" }] }],
  "skills": [{ "id": "s1", "items": ["…"] }]
}
```

**What the model may change**, stated in a new *Tailored CV* section of `server/prompts/drafter-procedure.md`:

- **Bullets** are reordered within their own role, most relevant first, and reworded in the post's terms.
  The fact is unchanged. Every bullet id appears exactly once.
- **Roles stay in date order.** Recruiters read dates top to bottom; reordering by relevance reads as
  hiding a gap.
- **Skills** — groups and items — may be reordered and are never renamed.
- **The summary** is written fresh for the role, but every fact in it must exist in the master CV.
- **Education, certifications and languages are not returned.** They render straight from the cache, so
  the model cannot touch them.

**What the model sees:** the cached master CV, with its ids, in the system prompt beside the existing
profile block — about 6,000 characters.

**Parsing is isolated.** `responseSchema` gains `cv: z.unknown().optional()`. Zod strips unknown keys by
default, so without it the block would silently vanish; with it the block's shape can never affect the
email's validation, and a malformed `cv` cannot fail `results`. A separate `tailoredCv(raw, master)` returns
either a checked CV or a rejection reason. Anything short of a clean pass attaches the original PDF.

## 3. The check

`tailoredCv(raw, master)` applies these rules in order. **The first failure rejects the whole CV**; the
original PDF is attached and the log names the rule and the id.

**Structure** — nothing added, dropped or moved:

1. Role ids exactly match the master's, in the master's date order.
2. Each role's bullet ids match that role's master bullet ids, each exactly once — none added, dropped or
   moved to another role.
3. The same set of skill group ids, in any order, and each group's items are the identical set, reordered
   only.

**Content**, per bullet against its own source bullet:

4. **No new numbers.** Every digit run — `40%`, `2019`, `3.5`, `20+` — must appear in the source bullet.
   This is the commonest way rewording inflates a claim.
5. **No new technology names.** A token that looks like one — containing a digit, `.`, `#` or `+`, or written
   all in capitals — must appear somewhere in the master CV.
6. **No keyword stuffing.** A reworded bullet may not exceed 1.5× its source length plus 20 characters. The
   slack keeps a short bullet from failing on ordinary rewording.
7. **No placeholders** — the existing `PLACEHOLDER` rule from `server/utils/drafter.ts`, reused.

The summary is checked by rules 4, 5 and 7 against the whole master CV rather than one bullet.

**The trade-off in rule 5 is deliberate.** Rewording in the post's terms invites borrowing the post's
vocabulary, and the post's technology names are exactly the ones most tempting to fabricate. Code cannot
tell a genuine synonym from an invented skill, so rule 5 blocks both. What survives is rewording of
everything else — verbs, framing, emphasis, order, the summary's angle — plus every technology term the CV
already contains.

## 4. Rendering, storage, attaching

**Rendering.** `renderCvHtml(cv, profile)` builds the HTML as a plain string, escaping every value as
`renderHtml` in `gmail.ts` does — no templating dependency. It is modelled on the current two-page layout
with the font stack `Carlito, Calibri, sans-serif`; Calibri is metric-compatible, so even the fallback breaks
lines identically. It is printed with `page.pdf()` in headless Chrome launched as `scripts/screenshot.mjs`
does. **A fresh non-persistent browser, never `./profile`**: the draft lane runs concurrently with the scrape
lane, which holds that profile's lock. One browser per draft job, launched on first use — so a batch
where every CV falls back launches nothing — shared across the batch and closed in `finally`. The template is built against the real PDF and compared side by side before it ships.

**Storage.** `createDraft` names the attachment `basename(cvPath)`, so the on-disk filename is what the
recruiter sees. Tailored CVs are written to `data/cv/tailored/<recruiter slug>/<cv filename>.pdf` — one folder
per recruiter, the same filename as the original, so a tailored CV is indistinguishable by name. `storeCv`
removes only `.pdf` files directly inside `data/cv/`, so `tailored/` survives a new upload — correctly, since
those files record what was sent.

**Recording what was sent.** A new nullable column, `contacts.cv_path`, added by a Drizzle migration and
written by `persist()`. `contacts` is the right grain: one recruiter, one application email, one CV. Deriving
the path from the recruiter instead was rejected — a later re-draft that falls back would leave the old
tailored file on disk, indistinguishable from what was sent. `null` means the original was attached.

**Attaching.** The apply path in `jobs.ts` passes the tailored path when the check passed, otherwise
`config.cv`. The follow-up in `sync.ts` passes `contacts.cv_path` when set and the file exists, otherwise
`config.cv`. The existing attached-byte-count verification covers both. Without Gmail, the local
`data/drafts/*.json` file records which CV path it would have attached.

## 5. Failure, visibility, the switch

**Every failure lands on the original PDF, never on a lost email:**

| Failure | Outcome |
|---|---|
| Extraction errors, or a bullet is absent from the verbatim text | Nothing cached; this job attaches the original; the next job retries |
| The drafter returns no `cv`, or a malformed one | Original attached |
| The check rejects under any of rules 1-7 | Original attached |
| Chrome will not launch, or `page.pdf()` throws | Original attached |
| The tailored file is gone at follow-up time | Original attached |

None can affect the email, because the `cv` block is parsed separately.

**A silent fallback is made visible.** Each email logs one line — `cv: tailored`, or
`cv: original — rule 4 at r0.b3: "60%" not in source`. The job summary totals the batch:
`cv: 7 tailored, 2 fell back`. The durable ratio needs no new storage: `contacts.cv_path` already records it
(`select count(cv_path), count(*) from contacts`). Reasons live only in the job log, capped at 400 lines and
lost on restart; a `cv_note` column is the upgrade path if that proves too thin.

**The switch.** `tailorCv: boolean` in Settings, **off by default** — the precedent `contactChannels` set by
defaulting to email-only, so an existing install is unchanged. It is also the rollback lever: one checkbox
returns every draft to the original PDF with no code change. When off, no extraction runs and nothing is rendered.
The master CV is simply not injected, so the procedure's Tailored CV section — written to apply only when
one is — stays inert. That is the procedure's existing pattern ("If no floor is injected, this skip does not
apply"); `drafter-procedure.md` is a static file and has no way to omit a section of itself.

## Testing

- **`test/cv.test.ts`** — `tailoredCv`: one passing case and one failing case for each of rules 1-7. The
  passing case matters as much as the failures: without it the check could quietly reject everything, the
  reasoning `test/drafter.test.ts` already applies to `PLACEHOLDER`. The cache match survives ligatures,
  line wraps and bullet glyphs but catches an invented bullet. Id assignment is deterministic.
- **`test/drafter.test.ts`** — a response with a malformed `cv` still parses its `results`.
- **`test/invariants.test.ts`** — CV rendering never opens `./profile` or a persistent context, and the
  response schema keeps `cv` as `z.unknown()`.
- **Identity** — fixtures and the template use fake names; the attachment filename comes from Settings at
  runtime, never a literal.
- **Live** — one real draft, the attached PDF opened side by side with the original.

## Deliberately out of scope

- Dropping experience irrelevant to a post — reorder and reword only.
- An owner review step for the extracted master CV.
- Reordering roles by relevance.
- Renaming skills or expanding synonyms.
- Persisting fallback reasons (`cv_note`).
- DOCX output.
- Bundling fonts: Carlito and Calibri are installed here, and a machine with neither falls back to
  `sans-serif`.

## Known ceilings

- **Rule 5 blocks genuine synonyms along with fabrications.** "service-oriented" becoming "microservices"
  is rejected when the CV never says "microservices". Deliberate.
- **Rule 5's heuristic misses an invented technology written in lower case** — "kubernetes" has no capital,
  digit, dot, `#` or `+`. A candidate tightening, to be measured against real post text during
  implementation rather than guessed at: build the technology vocabulary from tokens the heuristic matches
  in the *post* and the CV, then compare the bullet lower-cased, ignoring sentence-initial capitals.
- **Rule 4 does not read number words** — "five", "dozens".
- **The cache check is two model calls agreeing, not a proof.** The verbatim text is itself model output.
- **Whole-CV fallback is all or nothing.** One failing bullet discards every tailored bullet, so the
  fallback ratio is the metric to watch.

## Notes for the implementation plan

- `server/prompts/drafter-procedure.md` is scanned by `test/identity.test.ts` for gendered pronouns and
  contact-detail shapes; the new Tailored CV section must pass it.
- `tailorCv` belongs in `EMPTY_SETTINGS` in `shared/settings.ts`, and **key order matters** — the Settings
  page's dirty check is `JSON.stringify(form) !== JSON.stringify(data)`.
- `npm run typecheck` does not cover `scraper/`. Nothing here should live there, but any shared helper that
  does is verified only by tests and a real run.
- CLAUDE.md's "~1.4 MB" CV claim is stale and should be corrected in the same change.
