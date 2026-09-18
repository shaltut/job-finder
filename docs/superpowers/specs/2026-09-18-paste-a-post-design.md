# Paste-a-post intake — design

**Date:** 2026-09-18
**Status:** approved, not yet implemented

## Goal

A box in the Posts view where the owner pastes a job post that arrived outside LinkedIn — by email, by
WhatsApp, forwarded by a friend. The text runs the same pipeline a scraped post runs and lands in the Posts
list as an ordinary row. Pasting returns immediately; the scoring happens in the background, so the owner
can paste several in a row without waiting for any of them.

## Why

Good leads never pass through LinkedIn content search. The pipeline currently cannot see them at all, and
the only way to act on one is to leave the app entirely. Every downstream stage — scoring, flags, the
drafter, the Gmail gate, the follow-up sweep — already works on a `posts` row and does not care where the
row came from.

## What this is not

- Not a new pipeline. It is a second way to create a `posts` row; everything after that is unchanged.
- Not an exemption. A pasted post is scored, flagged and queued exactly like a scraped one. If it scores 4
  it does not draft, the same as any other 4. **The drafter queue predicate is not touched**, and neither
  are the invariant tests that pin it.
- Not a bulk importer. One post per paste.

## Architecture

The work splits by cost. Extraction and the contact-route gate are pure regex over a string — microseconds,
no network. Only the score is slow (one OpenAI call, plus a CV upload on a cold process). So the endpoint
does the fast half synchronously and queues the slow half.

```
POST /api/posts/paste { text }
  │
  ├─ SYNCHRONOUS — pure, no network
  │    readConfig()                    → 422 if the config is incomplete, with the missing-field list
  │    extractEmails / extractLinks / extractPhones   (scraper/lib.ts, unchanged)
  │    channelsOf({emails, links, phones}, text)
  │    admits(channels, config.contactChannels)
  │      ├─ false                      → 422 { found, enabled }      "no contact route in this post"
  │      └─ true
  │    dedupeKey('', text)
  │      ├─ key already in posts       → 200 { duplicate: true, key }
  │      └─ new
  │    enqueue('paste', { text })      → 202 { queued: true, key }
  │
  └─ BACKGROUND — the paste lane, one job at a time
       prescreen(text, config)                        → flags
       scorePost(text)                                → title, company, location, score, reason, post_type
       applyRecord(db, { op: 'post', ... })           → the same INSERT a scrape uses
```

### Why a third lane

`server/utils/jobs.ts` has two lanes. The scrape lane is held for the length of a whole scrape and the
draft lane for a `claude -p` session — both minutes. A paste is one OpenAI call, seconds. Queueing pastes
behind either defeats the point of backgrounding them, so `paste` becomes a third lane that runs
concurrently with both.

`pump()` already iterates `Object.keys(lanes)`, so it needs no change. `runJob` gains one branch with the
same shape as the existing `if (lane === 'draft')`: an in-process async function rather than a spawned
child, with `abort` wired to Stop.

### Why the strict config read

The gate needs only `contactChannels`, but scoring needs the CV, the scope and the titles, and `prescreen`
derives its `night-shift` rule from `constraints.workingHours`. Accepting a paste the pipeline cannot score
would queue work that is certain to fail. So the endpoint calls the **throwing** `readConfig()`, catches,
and returns 422 carrying the same readable missing-field lines a scrape refusal gives. Pasting is blocked
by an incomplete config, visibly, at the moment of pasting.

This is deliberate and is the opposite of the rule for `server/tasks/daily.ts`, which must survive a fresh
install and therefore uses `readConfigLoose()`. A paste is a foreground action with a person watching.

## The row a paste creates

| Column | Value | Why |
|---|---|---|
| `key` | `dedupeKey('', text)` | Empty author URL. Pasting the same text twice gives the same key, and the existing `ON CONFLICT (key) DO NOTHING` absorbs it. |
| `search_term` | `'pasted'` | Nullable, and it keeps the per-term yield table honest: pasted posts form their own bucket rather than inflating a real search term. |
| `author`, `author_url`, `post_url` | `null` | All three are nullable. **The drafter reads none of them** — verified: no reference to `post.author` exists in `drafter.ts`, `jobs.ts` or the procedure. They are display-only. |
| `posted_age`, `posted_at` | `null` | A paste carries no age. Both nullable. |
| `title`, `company`, `location`, `remote`, `in_scope`, `score`, `reason`, `post_type` | from `scorePost` | `SCORE_SCHEMA` fills all of them, and `gateOnPostType()` zeroes the score when the post is not a hiring post — the same protection a scraped post gets. |
| `emails`, `links`, `phones`, `ref_ids`, `channels` | from the regexes | Deterministic, never the model's, exactly as for a scrape. |
| `flags` | `prescreen(text, config)` | Including `excluded`, so the owner's exclude list applies to pasted posts too. |
| `text` | the pasted text, verbatim | |

No schema change and no migration: every column a paste leaves empty is already nullable.

## Sharing the scorer

`scorePost` currently lives in `scraper/run.ts` as ten lines over `systemPrompt`, `SCORE_SCHEMA` and
`gateOnPostType`, all of which are already exported from `scraper/lib.ts`. `loadCv` sits beside it and
sends the CV PDF as an `input_file`, **once per run**, reusing the returned text for every post scored.

Both move to a new `scraper/score.ts`, imported by `scraper/run.ts` and by `server/utils/paste.ts`. One
definition, so the two callers cannot drift. They do not go into `scraper/lib.ts`: that file is imported by
every test and is currently free of `openai` and `node:fs`, and it should stay that way.

**The CV text is cached on `globalThis`, keyed by the CV file's path and mtime.** Without a cache every
paste pays a CV upload; with it, one upload per server process. `globalThis` rather than module scope for
the reason `__jobfinderRunner` already uses it: Nitro's dev HMR reloads server modules on every edit and a
module-scoped cache would be discarded constantly.

## Failure handling

- **Scoring fails.** The job logs the failure and stores nothing — the same posture as a scraped post whose
  score fails, which is retried rather than stored with a NULL score. The difference is that a paste has no
  next run, so **the text is lost and the owner must paste again**. The paste box therefore shows the
  outcome of each paste made this session, and a failed one keeps its text so it can be resubmitted in one
  click. A durable pending table is deliberately not built: see Known limitations.
- **The server restarts with pastes queued.** The queue lives on `globalThis` and does not survive a process
  restart. Queued pastes are lost, with the same remedy.
- **The paste lane throws.** `runJob`'s existing `.catch` writes `failed: <message>` to the job log and
  finishes the job with exit 1, exactly as the draft lane does. One failed paste never stops the next.

## UI

A collapsible **Paste a post** card at the top of the Posts view, following the existing card conventions
(`class="shrink-0"`, since `UDashboardPanel`'s `#body` is a flex column and cards are clipped without it).

- A textarea and a **Add post** button.
- On 202: the box clears and a line appears in a small "this session" list — `queued`, then `scored 7` or
  `failed: <reason>`, polled from `GET /api/job`'s paste lane.
- On 422 (no contact route): the box keeps the text and shows what was found against what is enabled, e.g.
  *"No contact route found — 0 emails, 1 link, 0 phones; you accept: email."*
- On 422 (incomplete config): the missing-field lines, and a link to Settings.
- On 200 duplicate: *"You already have this post."* with a link to the row.

## Testing

`test/paste.test.ts`, following the existing suites (pure functions, no network, no browser, no live DB):

1. The gate admits a post carrying an enabled channel and refuses one that does not, with the found/enabled
   detail in the refusal.
2. `dedupeKey('', text)` is stable across two pastes of the same text and differs for different text.
3. The record built for `applyRecord` carries `search_term = 'pasted'` and nulls for `author`,
   `author_url`, `post_url`.
4. `prescreen` flags reach the record — an excluded needle in pasted text produces the `excluded` flag.
5. `laneOf('paste') === 'paste'`, and a queued paste does not occupy the scrape or draft lane.
6. A paste whose scoring throws stores no row.

**Fixtures use invented addresses** (`recruiter@example.com`). No real recruiter's address, and nothing of
the owner's, goes into a tracked file — `test/identity.test.ts` enforces the second and judgement enforces
the first.

## Known limitations, accepted

- **Paste-then-scrape makes two rows.** A post pasted today and scraped tomorrow keys differently, because
  the scraped row has an `author_url` and the pasted one does not. Two rows, one job. The Gmail gate means
  it cannot become two applications, but it is a visible duplicate. Deduping pasted rows on text alone was
  considered and rejected: it would make the pasted key a different shape from every other key, and the
  duplicate is cosmetic.
- **A lost paste is re-pasted, not recovered.** A durable pending table would survive a failed score and a
  server restart, at the cost of a new table, a migration and a retry loop for an operation that takes
  seconds. Start loud; add the table if it actually bites.
- **Hashtags can match the ref-id regex.** Measured on a real pasted post: one `ref_id` was extracted from
  hashtag text. Harmless — `ref_ids` is metadata only and is never a contact channel — but it means the
  field is noisier for pasted posts than for scraped ones.
- **One post per paste.** Pasting two posts in one box would need a splitter, and there is no reliable
  separator between two arbitrary posts.

## Global constraints

- No new dependencies.
- No identity literal — the owner's name, email, phone or handles — in any tracked file.
- The server remains the sole writer of the database.
- `npm test`, `npm run lint` and `npm run typecheck` must exit 0. Note `npm run typecheck` does **not**
  cover `scraper/`, so `scraper/score.ts` is only as verified as its unit tests and an actual run.
- Long-lived server state lives on `globalThis`.
- Every non-trivial change ships with one runnable check.
