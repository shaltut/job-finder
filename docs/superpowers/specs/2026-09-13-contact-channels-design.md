# Contact channels — saving posts that carry no email

**Status: implemented**, with `link` and `phone` shipped switched off pending a live measurement. The
design as agreed is kept below; the section at the end records what changed once the code met reality.

## Context

A scraped LinkedIn post survives only if its text contains an email address. The gate is one line —
`scraper/run.ts`, `if (!emails.length) continue` — and it sits **before** scoring, before the dedupe
check and before `prescreen()`. A post that says "apply at this link" or "WhatsApp me your CV" costs
nothing, is never scored, and leaves no trace. Every row in the database therefore carries
`emails.length >= 1` by construction, which several downstream queries quietly rely on.

The owner wants those posts kept: stored with whatever contact route they do carry, scored like any
other, and marked applied by hand — because no Gmail draft is possible without a recipient. Which
routes are admitted becomes a Settings choice, defaulting to email-only so an existing install
behaves exactly as it does today.

## What the stored corpus showed

Measured read-only across `data/jobfinder.db` (27 posts) and `backups/pre-wipe-2026-09-13.db` (21):

| Finding | Count |
|---|---|
| Posts whose text contains a URL | 7 / 27 |
| Of those URLs, `lnkd.in` shorteners | 11 / 11 |
| Of those URLs, actually an application link | 0 / 11 |
| `+countrycode` phone numbers | 1 / 48 |
| WhatsApp / Arabic equivalent mentions | 0 / 48 |
| Requisition IDs, strict regex | 0 / 48 |

Two conclusions, and they carry very different weight.

**LinkedIn rewrites every external link to an opaque `lnkd.in` shortener.** That is a property of
LinkedIn, not of this corpus, so it holds for posts nobody has scraped yet. The destination is
invisible in the text *and* in the anchor `href`, so filtering by domain — `lever.co`, `/careers` —
is impossible without following the redirect. All eleven links here were vendor CTAs ("tell us what
engineers you need and we will send a talent overview") or blog links. A bare "has a link" rule would
have admitted seven posts and been wrong seven times.

**The phone and requisition-ID counts prove nothing at all.** The corpus is email-bearing *by
construction*: a post saying "WhatsApp me your CV" is precisely the one the current gate discarded.
The stored data cannot measure the population this feature exists to capture. Hence the measurement
phase below, which must run before the admission rules are fixed.

## Decisions

### Channels are derived, admission is configured

A post can carry an email *and* a link *and* a phone, so there is no `type` enum. Three JSON array
columns mirror the existing `emails` pattern; the channel set is computed from them; Settings holds
an **admission set**, `contactChannels`, defaulting to `['email']`.

Extraction runs for every card unconditionally. Only *admission* is gated by the setting — so a post
admitted on its email still records the link and phone it carries. That asymmetry matters: it means
turning a channel on later enriches new posts without a re-scrape being required to see what was
already there.

### Link admission is cue-gated

Because the destination cannot be inspected, the only signal available is the surrounding prose. A
post is admitted on the `link` channel when it carries a non-LinkedIn link **and** an apply cue
appears in the text. Against the seven stored link-bearing posts this admits zero, which is the
correct answer for all seven.

Rejected: admitting any link and letting `gpt-5-nano` judge — one OpenAI call per marketing post, and
it moves contact extraction toward the model, which this codebase forbids for `emails` on purpose.
Also rejected, for now: resolving `lnkd.in` with a HEAD request per link, which would add outbound
requests correlated with the scraper's LinkedIn session. Revisit only if the measurement shows
cue-gating is too tight.

### The computed channel set is stored, not derived at query time

Extraction being unconditional means a post admitted on its email still records its `lnkd.in`
marketing link — seven of the current rows do. A UI filter written as `json_array_length(links) > 0`
would therefore return exactly the vendor CTAs the cue gate exists to reject. Writing the computed
set once, into a `channels` column, makes the scraper gate, the Posts badge and the channel filter
agree by construction — the same discipline that makes `emails` regex-written once and read
everywhere.

### Manual apply is `posts.applied_at`, not an `applications` verdict

The obvious move is a third verdict in `applications`. It is wrong twice over.

`dismissed_at` is already documented as orthogonal to `applications`, *not* a third verdict, and
manual apply is the same kind of thing: the owner's own triage, not the drafter's judgement about a
post.

More concretely, the follow-up sweep selects on `(a.key IS NULL OR a.reason NOT LIKE 'named in %')`.
A row carrying `verdict = 'manual'` and any sensible reason does not match `'named in %'`, so the
sweep would treat a manually-applied post as an unmentioned role and email a recruiter about a job
the owner had already applied for directly.

So: `applied_at`, nullable epoch seconds, mirroring `dismissed_at` exactly — same column shape, same
endpoint shape, same undo-by-symmetry, same invariant test. A manually-applied post never enters
`contacts`: Gmail is the truth about what was sent, and a link application is not mail.

### The `emails` guard becomes load-bearing

`json_array_length(p.emails) > 0` on the drafter queue is defensive today, since every row satisfies
it by construction. After this change it is the only thing standing between a link-only post and the
`contacts` upsert, whose `email` column is `NOT NULL` with `CHECK (email = lower(email))`. It is
pinned in `test/invariants.test.ts` alongside the three new `applied_at IS NULL` clauses.

## Sequence

Measurement comes first, because the extraction rules cannot be tuned against a corpus that excludes
the very posts they target.

0. Pure extractors in `scraper/lib.ts`, TDD, plus a dry-run log line that prints the channels found
   per card and whether the card would be admitted under each candidate rule. Then one `npm run dry`
   pass, which stores nothing and calls no model. Set the cue list and the phone rules from those
   counts. The dry candidates deliberately ignore `contactChannels` so the measurement is not gated
   by whatever the settings row currently says.
1. Schema, migration, ingest — including an `op: 'reextract'` record that names only the three
   extraction columns, so `dismissed_at` and `applied_at` survive the backfill.
2. The settings field and the scraper gate.
3. Downstream guards and the invariant tests.
4. API and UI.

## Out of scope

No draft of any kind for a link-only or phone-only post. No `contacts` row, stage machine or
follow-up for a manually-applied one. No `lnkd.in` redirect resolution.

## Known limits

`posts.text` is capped at 3000 characters by the card reader, so a contact detail past that cap is
invisible to every regex here. Pre-existing, unchanged by this work.

Widening admission widens the OpenAI bill: admission runs before `scorePost`, so every newly admitted
post is a scoring call, and `max` now caps a broader population.


---

# What changed during implementation

**The apply cue had to become proximity-aware.** The design said a link counts when "an apply cue appears
in the text". Running that over the two stored corpora admitted a BBC Writers post whose link is
introduced as "you can find Jess Loveland's blog post here" — because the prose 779 characters earlier
says DDN writers "no longer need to apply separately". Measuring the cue-to-link distance for all eleven
link-bearing posts separated the cases cleanly: the one genuine apply link ("How to Apply … or \<link\>")
sits 163 characters after its cue, the false positive 779, and the other nine have no cue before them at
all. `applyCueNear()` now looks only at the 300 characters before the link, with a whole-post fallback for
a DOM anchor the text never renders. A link *after* the cue window does not count: "\<link\>, apply by
email" is a link that is not the application route.

**A fourth column, `channels`, rather than deriving the set at query time.** Extraction is unconditional,
so a post kept for its email still records the marketing link beside it — and seven of the 27 live rows do.
A UI filter written as `json_array_length(links) > 0` would have returned exactly the vendor CTAs the cue
gate exists to reject. Writing the computed set once keeps the scraper gate, the Posts badge and the
channel filter from ever disagreeing.

**The yield table deliberately diverges from the `usable` KPI.** Both were going to gain `applied_at IS
NULL` together. They should not: the KPI measures what is still waiting for the owner, so an application
removes a post from it, while the yield table rates the *search term*. A dismissal is the owner saying a
post was not worth having and counts against the term that found it; an application is them saying it was.
Dropping applied posts there would make the best term in the table look like the worst.

**Channel order is normalised server-side.** The plan put the ordering in the Settings form's save path.
That leaves the guarantee depending on one client remembering to do it, so `parseSettings` now orders and
dedupes `contactChannels` the way it already normalises country names — the order the dirty check depends
on is a property of the stored row.

**Two things fixed that this feature only made worse.** The row-actions column was already being pushed
off-screen below about 1500px, and a third button would have made an unreachable Dismiss button harder
still; it is now sticky to the right, verified at 1440, 1280 and 1024 in both themes. And the guard
invariants were matching over whole files, so dropping `dismissed_at IS NULL` from the batch drafter queue
alone left the suite green — they are now sliced per query, and each of the four mutations was checked to
fail the right test.

## Measured live, 2026-09-14

120 cards over three job searches, plus 40 from the home feed:

| | link | email | email+phone | no channel |
|---|---|---|---|---|
| 3 job searches (120 cards) | **29** | 28 | 2 | 61 |
| home feed (40 cards) | 2 | 2 | 0 | 36 |

The `link` channel roughly **doubles** what a job search keeps, and the cue that fired was an "Apply now" /
"Apply here" / "Application link" every time — the gate is doing what it was designed to do on real cards,
where against the stored corpus it had only ever proved it could say no.

Two things the stored corpus could not have told us. **No post carried a phone alone**: the two phones
found sat beside an address, so `phone` adds enrichment rather than reach. **No requisition id appeared at
all** across 160 cards, so `ref_ids` is unearned weight for now — harmless, but not load-bearing.

The open question is recall. 59 of the 120 cards carried a link and 29 passed; of the 28 rejected, 7 —
four companies, evidently one template — do say "WE ARE HIRING". Those may be genuine misses (a cue outside
the 300-character window, or wording `APPLY_CUE` does not know) or the link may be a company page rather
than an application route. The dry snippet was 60 characters when this was measured, too short to tell, and
is 200 now. Re-run and read those rows before widening the cue list: loosening it is exactly how the vendor
CTAs get back in.
