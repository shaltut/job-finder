# Application gaps — design

**Status: approved design, not yet implemented.** Agreed section by section on 2026-09-21. The reasoning
behind each decision is kept here so it survives implementation.

---

## Context

The owner wants a record of what the jobs they apply to ask for and their CV does not show, for two uses:
enhancing the base CV later, and deciding what to learn. They will analyse the records with Claude Code in
this repository, so the database is the interface — nothing is exported.

Measured before designing:

- **`settings.background.gaps` is empty** (0 entries). The drafter only declares gaps from that list, so
  every one of the 109 drafted applications declared none, and the drafter's `gaps_declared` output is
  empty by construction. It is also discarded on the Gmail path — only `writeDraftFile` keeps it.
- **The scorer already writes free-text `Gaps: …` into `posts.reason`**, from `gpt-5-nano` at low effort.
  CLAUDE.md records that `reason` overclaims; prose from it cannot be ranked.
- **`data/cv/master.json`** exists — the structured master CV behind tailoring, cached against the PDF's
  sha256 by `loadMasterCv()`. It is the CV side of every comparison below, and its hash is the CV version.
- **109 drafted applications and 1 applied by hand** exist today, so a backfill has something to rank.
- **`gpt-5-nano` returns an empty requirements table** for this exact kind of judgement. Measured in
  `server/api/settings/background.post.ts`: nano 0 requirements, `gpt-5-mini` 17, and the empty table is
  valid against the strict schema, so the failure is silent.

**The governing risk is inventing requirements or coverage.** A requirement the post never stated, or a
"present" the CV does not support, would steer both the CV rewrite and the learning plan wrong. The
discipline already built in `shared/background.ts` applies: the model fills in a verdict table and code
drops every row it cannot justify, with quotes checked verbatim on **both** sides — the post and the CV.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Which posts | Applications only: `drafted` verdict or `applied_at` set | The owner's own judgement of relevance is the best signal |
| How gaps are captured | A dedicated extraction call per application | Covers hand-applied posts, backfills history, re-runs on a new CV; the drafter and scorer alternatives cannot |
| Model | `JOBFINDER_GAPS_MODEL`, default `gpt-5-mini` | Nano silently returns an empty table on this task (measured) |
| Trust | Verbatim quote checks on the post and the CV, in code | The model is not trusted to have read either |
| "Is it on my CV" | Whole-word match against the current CV text, computed at read time | Deterministic, never stale, and what an ATS actually checks |
| Grouping | Learn / Add now / On your CV | Separates what can honestly go on the CV today from what must be learned first |
| Page | Read-only ranking + copy keyword list | The owner's choice; analysis happens in Claude Code |
| Analysis | Claude Code reads the tables directly; CLAUDE.md documents them | Nothing leaves the machine |

## 1. Data model

Two tables, one migration.

**`post_requirements`** — one row per requirement per post.

| Column | Type | Meaning |
|---|---|---|
| `key` | text, FK → `posts.key` ON DELETE CASCADE | the post |
| `term` | text | the keyword as a CV would write it: `React`, `Kubernetes`, `NPHIES` |
| `category` | enum `technology`, `domain`, `certification`, `practice`, `language`, `other` | for filtering |
| `importance` | enum `must`, `nice` | as the post states it |
| `status` | enum `present`, `partial`, `absent` | the model's verdict against the master CV |
| `quote` | text | the post's own words stating the requirement, verified |
| `cv_shows` | text | the master CV's words that settle it; `''` for `absent`, verified |

Primary key `(key, term)`. The status vocabulary is `shared/background.ts`'s, deliberately — one meaning of
"partial" in this codebase, not two.

**`requirement_runs`** — one row per post extracted.

| Column | Type | Meaning |
|---|---|---|
| `key` | text PK, FK → `posts.key` ON DELETE CASCADE | the post |
| `cv_sha` | text | `pdfSha256` of the CV the post was compared against |
| `model` | text | which model answered |
| `kept` / `dropped` | integer | rows stored / rows the checks discarded, for spotting prompt drift |
| `extracted_at` | integer (epoch seconds) | when |

It is what makes "done" distinguishable from "not attempted" — a vague post can genuinely list nothing —
and what makes a new CV visible: a run whose `cv_sha` differs from the current master's is stale.

A re-run replaces a post's requirement rows and its run row in one transaction, so a post is never half
old CV, half new.

## 2. Extraction

One OpenAI Responses call per post, strict JSON schema, `reasoning: medium`, input:

- the post text,
- the master CV as text (`masterText`, exported from `server/utils/cv-tailor.ts`),
- instructions in the style of `backgroundInstructions()`: list what **this post** asks for, work from the
  post first and the CV second, never list a requirement in order to mark it absent.

The model returns `requirements: [{ term, category, importance, quote, status, cvShows }]`.

**Checks in code** (pure, in `server/utils/gaps.ts`), each drop counted and logged:

1. **`quote` must be in the post.** At 8 or more letters and digits it is compared loosely,
   `matchKey(post).includes(matchKey(quote))`, so a line wrap or a changed dash cannot hide it. Below that
   it must appear as a **whole word**, via `excludeRule([quote])` — because compared loosely "go" is inside
   "google". Short quotes are the common case, not an edge: posts list requirements as bare bullets, and
   13 of the 36 skills on the real CV are under 8 (`C#`, `Redis`, `AWS`, `CI/CD`). A flat 8-character floor,
   the first draft of this rule, would have dropped every one of them.
2. **`present` and `partial` must quote the CV**, found in `masterText` by the same rule.
3. **`absent` must not quote the CV** — a quote on an absence is a contradiction, as in `gapsFrom()`.
4. **`term`** is trimmed, capped at 60 characters, and must be non-empty; a second row with the same term
   (case-insensitive) on the same post is dropped as a duplicate.

**An empty table is logged loudly**, not treated as success, following `background.post.ts`: the run is
still recorded (a post may really state nothing), but the job log says which post returned zero rows and
names `JOBFINDER_GAPS_MODEL`.

**Cost**: gpt-5-mini at medium reasoning, under a dollar for the 110-post backfill and 10-25 minutes of
the draft lane, a few cents a day after. The post text and
the CV go to OpenAI — the same data the scorer and the tailoring already send.

## 3. The job

A `gaps` job kind on the **draft lane**, beside `draft` and `sync`. The draft lane rather than the paste
lane because a 110-post backfill would otherwise block pasting for minutes, and the paste lane exists to be
instant.

**Selection** — idempotent, so every trigger runs the same job:

```sql
SELECT p.* FROM posts p
LEFT JOIN applications a ON a.key = p.key
LEFT JOIN requirement_runs r ON r.key = p.key
WHERE (a.verdict = 'drafted' OR p.applied_at IS NOT NULL)
  AND (r.key IS NULL OR r.cv_sha <> @currentSha)
```

**Triggers**:

- after a draft job that drafted at least one post,
- after `POST /api/posts/applied` with `applied: true`,
- an **Extract gaps** button in the Run view's Maintenance row — which is also the backfill,
- the daily task (`server/tasks/daily.ts`), so a newly uploaded CV is picked up unasked.

`enqueue('gaps')` is a no-op while one is already **queued**. Unlike `sync` it is not refused while one
runs: a running job chose its posts when it started, so an application that arrives mid-run needs the
queued one to pick it up.

**Failure**: a post whose call fails writes nothing and is retried by the next job — the failed-score
posture. No CV uploaded, no master CV, or no `OPENAI_API_KEY`: the job exits with one readable line and
writes nothing. Stop is checked between posts.

The orchestration takes the model call and the store as injected dependencies, as `pasteOnce()` does, so it
is testable without OpenAI and without importing `jobs.ts`.

## 4. The page

**`GET /api/gaps`** aggregates over application posts only (the same application predicate as the job) and
returns every term — no paging; a few hundred terms is a small response. Terms group case-insensitively;
the displayed spelling and category are the most frequent ones.

**Grouping**, per term, in this order:

1. **Learn** — the most frequent status is `absent` (ties go to the worse status).
2. **On your CV** — otherwise, when `excludeRule([term])` matches the current master CV text.
3. **Add now** — otherwise: the experience is there, the keyword is not.

"On your CV" is computed per request against the **current** master CV and never stored, so updating the
CV moves a keyword out of Add now at once, before any re-extraction.

**`app/pages/gaps.vue`**, a **Gaps** entry in the sidebar between Pipeline and Run:

- Header: `106 of 110 applications analysed against your current CV` — application posts, against those
  whose run carries the current master's `cv_sha`.
- **Last seen** is the most recent application date among the posts asking: `applications.created_at` for
  a drafted post, `applied_at` for one applied by hand.
- Table: keyword · category · asked by (`12 applications · 8 must-have`) · group · last seen. Default shows
  Add now and Learn; a select picks Add now / Learn / On your CV / All, plus a category select — the same
  control the Posts view filters use.
- Ranked by applications asking, then must-have count.
- Row expansion: the applications behind the term — title @ company, must/nice, the post's quote, the CV
  line when there is one, and a link to the post when `post_url` exists.
- **Copy keyword list**, plain text, most-asked first:

  ```
  Add now — you have it, your CV doesn't say it
  - GitOps — 7 applications (5 must-have)

  Learn — not on your CV yet
  - React — 12 applications (8 must-have)
  ```

  On your CV is left out: nothing to change there.

## 5. Claude Code analysis

CLAUDE.md gains the two tables in the data model section, the grouping rule, a ready ranked query that
returns each term with its quotes and statuses, and a pointer to `data/cv/master.json` as the text to
enhance. It also records the one rule a CV-enhancement pass must follow: **Add now keywords may go onto the
CV; Learn keywords may not until the skill is real.** `tailoredCv()`'s checks already refuse technology the
master CV does not name, so the base CV is the only place honesty can slip, and this is where it is held.

## Testing

`node --test` against a migrated temp database, model call injected:

1. A requirement whose quote is not in the post is dropped; whitespace, case and punctuation differences
   are not a mismatch; a short quote matches only as a whole word, on the post and on the CV.
2. `present`/`partial` without a verifiable CV quote are dropped; `absent` with a CV quote is dropped.
3. Selection: drafted and applied-by-hand posts are picked, skipped and unprocessed posts are not, a post
   with a run at the current `cv_sha` is skipped, and the same post is picked again under a new sha.
4. A re-run replaces rows; no mix of old and new survives.
5. Grouping: most-frequent status wins, ties go to the worse; On your CV matches `C#`, `.NET` and a plain
   word on whole words only.
6. Queuing is verified live rather than in `node:test`, because no test can import `jobs.ts`: three POSTs to
   `/api/run/gaps` back to back return 202, 202, 200 — one running, one queued, one refused.

Live: run the backfill on the real database, compare `requirement_runs` against the 110 applications,
screenshot the page.

## Deliberately out of scope

- Statuses, notes or editing on the page — read-only by the owner's choice.
- Merging synonyms (`k8s` / `Kubernetes`) beyond asking the model for the canonical name.
- Writing anything to the CV, the master CV, `settings.background.gaps` or the drafter prompt.
- A market-wide view over non-application posts.
- Charts, a keyboard shortcut.

## Known ceilings

- **Canonicalisation is the model's.** Two spellings of one skill rank as two terms. The Claude Code pass is
  the place to merge them; a synonym table here would be a guess at the owner's vocabulary.
- **The quote checks prove the words exist, not that the reading is right.** A real quote can still be
  judged `present` generously. The CV quote narrows that to "the CV says something this close to it".
- **`drafted` is not `sent`.** A draft deleted unsent still counts as an application.
- **The whole-word check is ASCII-bounded**, as in `excludeRule()`: a term ending in a non-ASCII character
  matches as a substring at that edge.

## Notes for the implementation plan

- The job-kind touch points CLAUDE.md lists: `Kind` in `server/utils/jobs.ts`, `JobKind` in
  `app/types/index.d.ts`, `laneOf()`, the draft-lane dispatch in `runJob`, `enqueue()`'s dedupe, and a
  `POST /api/run/gaps` endpoint beside the others.
- `masterText` must be exported from `server/utils/cv-tailor.ts`; it is the only full-text view of the
  master CV, and the quote check must see every field it spreads.
- `matchKey` is exported from `server/utils/cv-master.ts`; `excludeRule` from `scraper/lib.ts`, which
  `server/utils/paste.ts` already imports, so the server may too.
- Migrations are generated with `npm run db:generate`; on Windows `db:migrate` fails on a fresh clone and
  `npm run dev` migrates at boot.
