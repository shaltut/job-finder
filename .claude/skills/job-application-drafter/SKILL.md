---
name: job-application-drafter
description: Use when screening a scraped LinkedIn job posting from the jobfinder Postgres database, or a pasted posting, against Ahmed Shaltoot's profile; when asked to draft or batch-draft application emails as Gmail drafts; and when checking whether a recruiter was already contacted, drafting the 3-day follow-up, or closing a recruiter out.
---

# Job Application Drafter

Turns a job posting into either a reasoned SKIP or a tailored Gmail draft. Never sends.

**The hard rule: never claim experience Ahmed does not have. Gaps get declared explicitly in the email.**
A recruiter who screens him out on a stated gap costs one email; one who discovers it at interview costs a
process and a reputation. Every claim in a draft must trace to Step 3. If it is not there, it does not go in.

## Step 1 — Load the posting

**Database** (local Homebrew Postgres, trust auth, `psql` is not on PATH):

```bash
/opt/homebrew/opt/postgresql@15/bin/psql -d jobfinder -c "\d posts"   # confirm the schema before querying
```

Always call `psql` by that full path, literally, never through a shell variable or alias: the headless run only
permits shell commands that start with it. The schema for all three tables lives in `schema.sql` and is applied
by `jobfinder.js` and `ui.js` at startup; the DDL below is a copy for reference.

`posts`: `key` (pk, sha1 of author + text) · `scraped_at` · `search_term` · `author` · `author_url` · `posted_age` ·
`title` · `company` · `location` · `remote` · `mena` · `emails text[]` · `score` (0-10, the scraper's model scored
the post against the CV) · `reason` · `text` (full card text; starts with the LinkedIn header, body follows) ·
`flags text[]` (regex red flags from the scraper: `residency-gate`, `junior`, `junior-years`, `immediate-start`,
`night-shift`; they mirror Step 2's hard skips but are hints: confirm each in the text).
If the connection is refused: `brew services start postgresql@15`.

Treat `score` as an ordering hint, never as a verdict; the screen in Step 2 is stricter than the scraper's rubric.
`reason` is model-generated and overclaims (it has credited Terraform, which he lacks): never copy it into an email.

**Tracking table** — create it on first use, then every verdict is recorded here so batch runs never redo a post:

```sql
CREATE TABLE IF NOT EXISTS applications (
  key text PRIMARY KEY REFERENCES posts(key), verdict text NOT NULL CHECK (verdict IN ('drafted','skipped')),
  reason text, recruiter_email text, gmail_draft_id text, created_at timestamptz NOT NULL DEFAULT now());
```

**Unprocessed posts, best first** (batch default: the top 10, or whatever count was asked for):

```sql
SELECT p.key, p.score, p.flags, p.title, p.company, p.location, p.emails, p.author, p.text
FROM posts p LEFT JOIN applications a ON a.key = p.key
WHERE a.key IS NULL ORDER BY coalesce(cardinality(p.flags), 0) > 0, p.score DESC NULLS LAST, p.scraped_at DESC LIMIT 10;
```

**One email per recruiter, not one per posting.** Group the batch by `emails[1]`; a second posting from the same
address gets `verdict = 'skipped', reason = 'same recruiter as <key>'`, and the one email names both roles.
Near-identical text from different authors is usually the same role reposted: draft once. Then run Step 1b for
every recruiter address before screening its posts.

Pasted postings skip the `posts` query; Steps 1b-8 still apply.

## Step 1a — Stage sweep (every run, before anything else)

A recruiter's stage changes without any new post appearing: Ahmed sends the draft, the recruiter replies, three
days pass. So every run starts by re-checking every open address, whether or not it has a post in the batch:

```sql
SELECT email, stage, last_sent_at FROM contacts WHERE stage IN ('drafted','contacted','followed_up');
```

For each address run Step 1b's Gmail lookup and apply its table exactly as if the address had a post in the
batch, with nothing to record in `applications` unless a follow-up names posts. Typical moves: `drafted` becomes
`contacted` once the sent message is in Gmail (set `last_sent_at` to Gmail's sent time and `thread_id`);
`contacted` gets the follow-up drafted at 72 h; `followed_up` becomes `final` once the second message is in Gmail
with no reply; any reply becomes `replied`. When asked to "sync" or "sweep", do only this step and report every
stage change and every follow-up drafted.

## Step 1b — Recruiter stage: new application, follow-up, or final

Each recruiter address gets at most two emails from Ahmed, ever: the application and one follow-up after three
days of silence. After that the address is final and gets nothing more. Gmail is the truth about what was sent
(a draft is not a contact until Ahmed sends it); the database only remembers the stage. `contacts` holds only
addresses that have actually been drafted to: a recruiter whose every post is hard-skipped gets no row.

```sql
CREATE TABLE IF NOT EXISTS contacts (
  email text PRIMARY KEY, stage text NOT NULL CHECK (stage IN ('drafted','contacted','followed_up','replied','final')),
  thread_id text, last_sent_at timestamptz, note text, updated_at timestamptz NOT NULL DEFAULT now());
```

1. `SELECT stage, last_sent_at FROM contacts WHERE email = $1`. If `final`: no Gmail lookup and no email, but every
   post from the address still gets an `applications` row, `skipped`, reason `recruiter final`, so it never resurfaces.
   Also run the Step 2 hard skips on the address's posts now: if every one of them is hard-skipped, record those
   verdicts and stop; no Gmail lookup and no `contacts` row.
2. Otherwise look the address up in Gmail (load the tools with
   `ToolSearch("select:mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread")` if deferred):
   `search_threads` with `query: "to:<email> OR from:<email> OR \"<email>\""` (the quoted form also catches a
   bounce that Gmail threaded separately; sent mail is included, drafts are excluded, which is the point), then
   `get_thread` with `messageFormat: "MINIMAL"` on each hit. Classify every message, testing in this order:
   - **outgoing**: sender is itshaltoot96@gmail.com. Note the date-time of the latest one.
   - **bounce**: sender is mailer-daemon or postmaster, or the subject says "undeliverable" or "delivery status".
   - **auto-reply**: a noreply / no-reply sender, or subject or snippet with "automatic reply", "auto-reply",
     "out of office", or "we have received your application". Not a reply.
   - **reply**: any other incoming message from the recruiter's address or domain.
   Silence is the elapsed time since the latest outgoing message's timestamp, compared as instants (timezone is
   irrelevant to the difference); 72 hours or more is "3 days". Report due dates in Cairo time.
   For rows 4 and 7, confirm the pending draft still exists with `list_drafts`, `query: "to:<email>"`, or
   `get_draft` on the `gmail_draft_id` stored in `applications` (`search_threads` never returns drafts, even with
   `in:draft`; trusting it once nearly produced a duplicate). If the draft is gone, treat the stage as if it had
   never been made (row 6 or row 8 applies instead).
3. Take the first row that matches, top to bottom. Then upsert `contacts` and insert an `applications` row for
   every post from the address (the "Posts get" column), so no post is ever seen twice.

| # | Gmail shows | DB stage | Do this run | New stage | Posts get |
|---|---|---|---|---|---|
| 1 | a bounce | any | nothing; report the dead address | `final`, note `bounced` | `skipped`, `recruiter final` |
| 2 | a reply | any | nothing automatic; report it, Ahmed answers by hand | `replied` | `skipped`, `recruiter replied <date>` |
| 3 | 2+ outgoing, no reply | any | nothing | `final`, note `no reply after follow-up` | `skipped`, `recruiter final` |
| 4 | 1 outgoing, no reply | `followed_up` | nothing; report "follow-up draft pending, send it" | `followed_up` | `skipped`, `follow-up pending` |
| 5 | 1 outgoing, no reply, under 72 h | any | nothing; report the date the follow-up is due | `contacted` | `skipped`, `recruiter contacted, follow-up due <date>` |
| 6 | 1 outgoing, no reply, 72 h or more | any | draft the follow-up (below) | `followed_up` | named in it: `drafted`, `named in follow-up`; others `skipped`, `hard-skipped, not named` |
| 7 | nothing outgoing | `drafted` | nothing; report "application draft pending, send it". Never edit the pending draft | `drafted` | `skipped`, `application draft pending` |
| 8 | nothing outgoing | none | Steps 2-7: screen; then `list_drafts` with `query: "to:<email>"` and only if it is empty create the draft (a crash between an earlier create and its SQL would otherwise produce a second one) | `drafted` only if a draft exists (thread_id and last_sent_at null) | `drafted`, `named in application; <fit>`, or `skipped` with the Step 2 reason |

Posts skipped in rows 5 and 7 are not lost. The follow-up names every post from the address that no sent email
has named yet, batch or not:

```sql
SELECT p.key, p.title, p.company FROM posts p LEFT JOIN applications a ON a.key = p.key
WHERE $email = ANY(p.emails) AND (a.key IS NULL OR a.reason NOT LIKE 'named in %');
```

Every `applications` write is an upsert, `ON CONFLICT (key) DO UPDATE SET verdict = EXCLUDED.verdict, reason =
EXCLUDED.reason, gmail_draft_id = EXCLUDED.gmail_draft_id`, so a post skipped in an earlier run can be promoted to
`named in follow-up`. Posts that arrive after the follow-up is sent are reported to Ahmed and never emailed: two
emails per address is the ceiling.

**The follow-up** is a reply in the same thread: `create_draft` with `replyToMessageId` set to the id of Ahmed's
sent message, `to` the recruiter, no subject (the thread's is inherited). Four to six sentences, plain text: the
role and the date of the original email; still interested; one line naming any roles from the query above that
pass the Step 2 hard skips; an offer to provide anything further; "CV attached again". No new claims and no new
evidence; the application already made the case. Ahmed attaches the CV by hand, same as Step 7.

```sql
INSERT INTO contacts (email, stage, thread_id, last_sent_at, note) VALUES (lower($1), $2, $3, $4, $5)
ON CONFLICT (email) DO UPDATE SET stage = EXCLUDED.stage, thread_id = EXCLUDED.thread_id,
  last_sent_at = EXCLUDED.last_sent_at, note = EXCLUDED.note, updated_at = now()
WHERE contacts.stage <> 'final';   -- final is never reset, by the database, not by prose
```

Addresses are always lower-cased before any query or insert; the table rejects anything else.

## Step 2 — Screen it

### Hard skips (do not draft; record and report the reason)

- **Personal email addresses are not a skip.** Ahmed decided on 2026-09-08 that gmail, yahoo, outlook and the
  like are treated exactly like company addresses: in Egypt and the Gulf many real HR people and recruiters post
  that way. Screen the post on its content, draft, and attach the CV as usual.
- **Residency gate he does not meet.** "Transferable QID", "locally available in <country>", "must have work
  authorisation in <country>".
- **Location outside scope.** In: Saudi Arabia, UAE, Qatar, Egypt, genuinely location-free remote, and (Ahmed's
  decision, 2026-09-08) remote roles from India-based employers, including "remote within India", as long as no
  office days are required and the hours fit the Cairo window. Out: Europe, UK, US on-site, on-site or hybrid
  anywhere outside the Gulf and Egypt (Hyderabad work-from-office, "remote with mandatory weeks in Trivandrum"),
  Syria-only, Pakistan-only. US-only work authorisation or W2 requirements remain residency gates.
- **Level below senior.** 5 or fewer years required, "freshers", or a req with no architecture, ownership, or
  mentoring in it. He directs a 20+ person organisation.
- **Working hours outside roughly 09:00-21:00 Cairo.** US EST coverage lands at 16:00-01:00; IST night shifts
  similar. Compute the actual Cairo window (UTC+3 in summer, UTC+2 in winter) and state it in the report.
- **A mandatory requirement he genuinely lacks:** banking sector experience, Java as the primary backend, Blazor,
  ABP Framework plus Appian together, GL/AP/AR/payroll engines built from scratch.
- **Immediate start required.** He has a notice period.
- **No content.** No stack, no level, no location, no salary: nothing to tailor to.

### Soft flags (draft, but say the odds are low in the report)

- **14+ years required.** He has 9+. At staffing firms the years figure is usually a client rate band, so it is a
  hard screen even when the recruiter likes him. Lead the email with the gap.
- **Current Angular or React as a core requirement.** See Step 4.
- **Staffing-firm vendor deployment** rather than a seat on a team.
- **Unnamed client, unstated location or rate.** Draft short and ask.
- **India-based remote role.** Usually an Indian rate band; draft, and ask for the compensation band and the
  time-zone expectation in the email.

### Prioritise

Rank higher when the posting asks for things that are scarce in him: Arabic (native) · LLMs genuinely in
production · NPHIES, Saudi regulatory, government-scale delivery · enterprise SSO, OIDC, identity integration ·
Kubernetes plus Argo CD by name · large-scale SQL performance and migration work · multi-tenant SaaS with
row-level isolation.

## Step 3 — Facts to draw on (use only these; the CV PDF at ~/Documents/AhmedShaltootCV1.pdf wins on conflict)

**Identity.** Ahmed Shaltoot · Cairo, Egypt · +20 109 158 5331 · itshaltoot96@gmail.com ·
linkedin.com/in/ahmedshaltoot · shaltoot.cloud. Arabic native, English full professional. B.Sc. Computer Software
Engineering, Damietta University (2017); ITI professional diploma (2018).

**Current role.** Director of Engineering, TachyHealth (Sep 2020-present; Director since Apr 2025). Promoted
three times in five years: Senior Engineer, Lead, Director. 9+ years in software, 8 in healthcare technology.
Still hands-on. Leads 20+ people across engineering, DevOps and AI behind a multi-tenant SaaS claims processing
and RCM platform serving payers and providers across Saudi Arabia, the UAE and the US. Millions of claims
monthly. Owns architecture, technical roadmap, hiring, and vendor and buy-vs-build decisions across three clouds.

**Evidence to cite (all real):**

- Zero-downtime migration of the flagship claims product: 50M+ records at terabyte scale, Azure CosmosDB +
  Elasticsearch to PostgreSQL as single source of truth. Zero data loss, 100% reconciliation.
- LLM-based ICD-10 coding and clinical documentation taken from model benchmarking through guardrails to full
  production, including GPU capacity planning on Oracle Cloud. Production, not a proof of concept.
- NPHIES vendor certification for Saudi payer integrations; unlocked KSA market entry. National health
  infrastructure with the governance and data-residency standards that implies.
- Production incident resolution: CPU saturation, write amplification, query plan regressions, fixed via indexing
  strategy and query rewrites under full load.
- Rebuilt the engineering delivery practice: AI-assisted code review (CodeRabbit), containerized integration
  testing (Testcontainers, Playwright), progressive delivery (Argo Rollouts). Adopted org-wide; measurably
  improved deployment frequency and change-failure rate.
- ADFS / OpenID Connect SSO integration for Tawuniya (large regional insurer): token handling, claims mapping,
  RBAC across an enterprise identity boundary. **Not on the CV.** Use it in the email whenever identity, SSO,
  OAuth, OIDC or Entra ID is asked for; it is his best answer to those requirements.

**Stack.** .NET / .NET Core, C#, Python · microservices, event-driven, gRPC, RabbitMQ, REST · PostgreSQL
(large-scale tuning), MSSQL, MongoDB, Redis, Elasticsearch, CosmosDB · Kubernetes, Docker, Argo CD, CI/CD, Azure,
GCP, Oracle Cloud · DDD, Clean Architecture, SOLID, DI · NPHIES (FHIR R4), HIPAA, PDPL, ICD-10, claims
adjudication, RCM, FWA detection, pharmacy benefits, EMR/HIS.

**Earlier.** Founder, Core System (AI/ML venture, 2021-2024, wound down). Freelance .NET full-stack 2017-2020:
30+ projects, predominantly healthcare with notable fintech; .NET Core, Azure Functions, AWS Lambda,
Angular/TypeScript. UISCOM (2019-2020): enterprise ERP applications, full lifecycle. MolTaqa (2018-2019): .NET
web applications.

## Step 4 — Gaps: state them, never paper over them

- **Angular / TypeScript:** real but dated. 30+ projects in 2017-2020, nothing recent. Not current on Angular
  14+, RxJS or NgRx. **No React at all.**
- **No experience:** ABP Framework, Appian, Blazor, Java, Sybase, MassTransit, Kafka, NATS, .NET Framework 4.8
  (recent work is Core), SOAP, jQuery, SVN, AngularJS, DevExpress, Dapper / Mapperly / FluentValidation specifically,
  Terraform, Databricks, Azure Data Factory.
- **Not named on the CV:** xUnit / NSubstitute / FluentAssertions (he has Testcontainers and Playwright), Azure
  DevOps by name.
- **Domain gaps:** no banking; no GL / AP/AR / payroll built from scratch. Healthcare claims adjudication and RCM
  is the adjacent argument: money movement, reconciliation, regulated data, correctness where an error is a
  financial event. Make that argument; do not overstate it as accounting.
- **Certifications:** no PMP, no Azure certifications.
- **Cloud:** AWS is historical (Lambda, freelance era). Current depth is Azure, GCP, Oracle Cloud.
- **Years:** 9+. Say so plainly against any 10+ / 14+ / 15+ / 16+ requirement.

## Step 5 — Constraints

- **Relocation:** Gulf only: Saudi Arabia, UAE, Qatar. Not Europe. Egypt-based and remote roles also in scope.
- **Notice period:** cannot start immediately.
- **Level:** currently Director; applying to senior IC or Lead roles is deliberate. When the target level is below
  Director, use this sentence and do not invent a motive: "This role sits below my current Director title; that is a
  deliberate choice on my side, not an omission."

## Step 6 — Write it

**Subject.** The exact string if the posting specifies one (some do: "SFSNA", "Senior .NET Developer – Dubai",
".NET Team Lead"). Otherwise: `<Role> — Ahmed Shaltoot | <two or three differentiators that match their asks>`.

**Body, in this order:**

1. One line: which role, where seen.
2. Position statement: current title, org size, what the platform does and for which markets, years, still hands-on.
3. Their requirements mapped one by one, each with concrete evidence from Step 3, in their vocabulary and their
   order. Skip requirements he cannot speak to rather than padding.
4. A short paragraph naming the gaps, ending with the honest conditional: if the role needs X from day one, I am
   not the closest fit; if the weight is on Y, I would be a strong one.
5. Level transparency, when applying below Director.
6. Location / relocation line, matched to Step 5.
7. Sign-off block: phone, email, LinkedIn, site.

**Tone.** Direct, specific, no superlatives about himself. Numbers over adjectives. Recruiter emails and
unnamed-client staffing reqs get a short version plus a question about client, location, rate and timezone; named
companies with real job specs get the full treatment.

## Step 7 — Save the draft

Create a Gmail **draft**, never a send. The tool is `mcp__claude_ai_Gmail__create_draft`; if it is deferred, load
it first with `ToolSearch("select:mcp__claude_ai_Gmail__create_draft")`. Address it to the posting's email.
Immediately before calling it, run `list_drafts` with `query: "to:<email>"`: if a draft to that address already
exists, do not create another; record its id instead. Write the `applications` and `contacts` rows right after
the draft is created, before the report.

Do not attach the CV through the tool: its `attachments` field takes base64 inside the call parameters, and a
75KB base64 string reproduced by the model will be silently corrupted. The CV is attached by `ui.js` instead: it
rewrites every draft addressed to a known recruiter with the PDF bytes from disk, automatically after each run
started from the UI, or from the Pipeline view's "Attach CV to waiting drafts" button. Still write "CV attached"
in the email. In the report say: **"CV attached automatically if Gmail is connected in the Pipeline view;
otherwise attach AhmedShaltootCV1.pdf by hand"**. When this skill runs outside the UI, remind Ahmed to press the
button.

Pass both `body` (plain text: write `&`, not `&amp;`; no HTML entities, no markdown) and `htmlBody`: the same text
with line breaks as `<br>` and the two signature links as real anchors,
`<a href="https://linkedin.com/in/ahmedshaltoot">linkedin.com/in/ahmedshaltoot</a>` and
`<a href="https://shaltoot.cloud">shaltoot.cloud</a>`. Bare URLs in a plain body get rewritten by Gmail into
`google.com/url?q=` redirects, which is what two sent applications went out with.

Then record the verdict for every post touched this run, including the skipped ones, so the next run never
sees them again, and upsert the recruiter's stage in `contacts` (Step 1b):

```sql
INSERT INTO applications (key, verdict, reason, recruiter_email, gmail_draft_id)
VALUES ($key, 'drafted', 'named in application; ' || $fit_summary, $email, $draft_id)
-- or: ($key, 'skipped', 'free-email contact', $email, NULL)
ON CONFLICT (key) DO UPDATE SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, gmail_draft_id = EXCLUDED.gmail_draft_id;
```

The `named in ...` prefix is load-bearing: Step 1b's follow-up query uses it to find posts no sent email has
mentioned yet.

## Step 8 — Report

Per posting, briefly:

- **Verdict:** drafted, follow-up drafted, or skipped with the reason.
- **Recruiter stage:** from Step 1b, with the date the follow-up becomes due or the reason the address is final.
- **Why it fits:** the two or three requirements where he is genuinely scarce.
- **What was declared:** the gaps written into the email.
- **What needs his judgement:** anything only he can confirm (relocation willingness, whether a stale skill is
  actually current, notice period length).

For batch runs, finish with a ranked shortlist rather than a flat list. Most of the value is in the ordering.

## Verify before finishing

- Every claim traceable to Step 3. No invented projects, employers, or metrics.
- Every gap in Step 4 that the posting asks for is declared, not omitted.
- Location assertion matches Step 5. Never "willing to relocate to <European city>".
- Exact subject line used where specified.
- Draft created, not sent. CV line present in the email and the attachment note in the report. Verdict recorded
  in `applications` for every post touched, and the recruiter's stage upserted in `contacts`.
- The Step 1a sweep ran first, so no open recruiter is stuck at a stale stage.
- No address ever gets a third email: `final` is checked before anything else and is never reset.

## Snapshot warning

Steps 3-5 are a snapshot from 2026-09-06. If Ahmed refreshes Angular, gains a certification, or his notice period
changes, update this file, otherwise drafts keep hedging on things that are no longer true.
