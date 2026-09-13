# Settings in SQLite, prefilled from the CV

**Status:** implemented. Supersedes the §Config section of `2026-09-10-nuxt-rewrite-design.md`.

## Why

`config.json` was the single source for the profile, constraints and search settings. Three things
were wrong with that:

1. **It was git-tracked and carried real contact details** — a phone number and an email address in a
   repository whose remote is `the original author's repository`, the original author's.
   `CLAUDE.md` carried a "do not push without confirming the remote" warning that existed largely
   because of this file.
2. **A fresh install started with someone else's data.** Retargeting the tool was meant to be data
   entry, but that meant 20 fields typed by hand with no help from the CV already on disk.
3. **The inputs fought the data.** Terms and titles were edited as a `join('\n')` / `split('\n')`
   textarea; the country pickers were hardcoded to eight MENA countries, so the app could not express
   a scope it was not born with.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Storage | One row, one JSON column | Nothing queries an individual setting; every consumer wants the whole object. Normalising would cost a rewrite of the Settings PUT and buy nothing. |
| CV input | Upload into `data/cv/` | A browser file picker cannot produce an absolute path, so "give it the CV" via the UI means upload. `data/` is already gitignored. |
| Prefill scope | Empty fields only | A value you typed is never replaced by one a model inferred, which makes the button safe to press twice. |
| Country list | Bundled ISO 3166 with aliases | See below. |
| `config.json` | Imported once at boot, then removed | Takes the PII out of the tree. |

### Why not LinkedIn for the country list

The request was to source countries from LinkedIn so the names match. Country names never reach a
LinkedIn URL — they appear only as prose inside two prompts, `systemPrompt` in `scraper/lib.ts` and
`profileBlock` in `server/utils/drafter.ts`. LinkedIn publishes no country-list endpoint; reading its
taxonomy needs the logged-in session and extra authenticated requests against the same account the
scraper deliberately rate-limits.

What actually matters is that the *model* recognises whichever form a post uses. A bundled list with
aliases delivers that offline: `withAliases()` renders `UAE (United Arab Emirates, Emirates)` into the
scoring prompt.

Making the list dynamic exposed two hardcodings that were quietly wrong:

- `scraper/lib.ts` hinted at the email domains `.eg .sa .ae .qa`. Now derived by `tldsFor()`, with a
  ccTLD override table for the cases where the ccTLD is not the alpha-2 code (`GB` → `.uk`).
- The out-of-scope sentence named "Europe, UK, US, India, elsewhere in MENA" — actively false the
  moment Kuwait is selected. Now stated relative to whatever is configured.

## Shape

```
shared/settings.ts     schema, EMPTY_SETTINGS, readSettingsFrom/writeSettingsTo, importLegacy, mergeEmpty
shared/countries.ts    ~198 ISO entries with aliases; resolveCountry, tldsFor, withAliases
       │
       ├── server/utils/config.ts    readConfig / readConfigRaw / readConfigLoose / writeConfig /
       │                             patchConfig / assertComplete  (over the db singleton)
       ├── scraper/run.ts            reads it through its own READ-ONLY handle
       └── app/types + settings.vue  types only, plus COUNTRIES as data
```

`shared/settings.ts` is pure — Zod only, no `node:fs`, no `better-sqlite3` import — so all three
processes and the browser's type layer read one definition. The SQL handle is duck-typed
(`{ prepare(sql) }`) precisely to keep `better-sqlite3` out of that import graph; the parameter type
is `string[]` rather than `unknown[]`, which is what makes better-sqlite3's overloaded `Statement`
assignable to it contravariantly.

This collapsed three hand-maintained copies of the same shape into one: the server's Zod schema,
`scraper/lib.ts`'s `Config`, and `app/types/index.d.ts`'s `AppConfig`.

### Two schemas, and why the split is load-bearing

The old schema refused an empty terms list and ran `existsSync` on `cv`. On a fresh database that
makes Settings unsaveable — and you cannot upload a CV to fix it, because you cannot save the page.

- **`settingsSchema`** checks shape and format only. Every key present; strings may be `''`; arrays
  may be empty; `email` must be an email *when non-empty*. This is what `writeConfig()` validates, so
  a half-filled form saves.
- **`missingFields()` + `assertComplete()`** are the run gate. `readConfig()` calls them, so
  scrape/draft/sync still refuse to start on an incomplete config with a readable line per problem.
  The CV file check lives in `server/utils/config.ts` rather than `shared/`, because only the server
  should touch the filesystem to answer it.
- **`readConfigRaw()` / `readConfigLoose()` never throw.** The Settings page has to load in order to
  *fix* what is wrong, and the Gmail status card renders on that same page.

Two callers needed adjusting for the empty state: `server/tasks/daily.ts` (a strict read there would
have cost the nightly backup) and `server/api/gmail/status.get.ts`, where `?? null` passed `''`
straight through and fired the account-mismatch banner against a blank address.

### The scraper stays read-only

`scraper/run.ts` opens its own connection with `{ readonly: true, fileMustExist: true }`, the same way
`knownKeys()` already did. The rule in `server/utils/db.ts` holds: the Nitro server is the sole
writer, and two writers is how you get `SQLITE_BUSY` under a long scrape.

Passing the config in on stdin from the server was the alternative and was rejected — it would break
`npm run dry`, `--rescore`, `--reflag` and the `node scraper/run.ts | node scraper/ingest.ts` pipe,
all of which run with no server at all. The argv-wins precedence is unchanged: argv, then the stored
settings, then the hardcoded fallbacks.

### The one-time import

`server/plugins/migrate.ts` reads `config.json` after migrations and writes it into the row if the row
is missing. Idempotent — the row existing is what makes it a no-op, so it cannot overwrite later
edits. Legacy country spellings resolve through the alias table, so `"UAE"` and
`"United Arab Emirates"` land on the same entry.

A Drizzle migration could not seed the values instead: `test/invariants.test.ts` fails if a contact
detail appears anywhere under `server/`, and putting one there would defeat the rule that test
protects. Reading the file at runtime keeps the source clean — which is also why a genuinely fresh
install onboards through upload-CV-then-prefill rather than through a seeded row. The two asks turned
out to be one flow.

### Prefill

`POST /api/settings/prefill` is the first OpenAI client on the server side. It reuses the pattern from
`scraper/run.ts`: the PDF inlined as a base64 data URL in `input_file` (no Files API), and the
Responses API's `text.format.{type,name,strict,schema}` nesting rather than Chat Completions'
`response_format`. Strict mode requires `additionalProperties: false` and every property in
`required`, so the model always returns the whole shape and emits `''` for anything the CV does not
state.

It extracts `profile.*`, `titles` and `terms`. It is **not** asked for `onsiteCountries`,
`willRelocate`, `remoteAnywhere`, `canStartImmediately`, `workingHours`, `stackWeighting`, `max` or
`since`. A CV cannot know where you will relocate to, and a model asked for it invents an answer that
then goes out in a real job application.

`mergeEmpty()` fills only blank fields, and drops just the fields whose format check fails rather than
rejecting the whole prefill — a bad LinkedIn URL must not cost you the name. The endpoint returns the
merged config **without saving**; you see it in the form and press Save.

Observed against the real CV: it filled name, title, location, email, phone, languages,
yearsExperience, 20 titles and 9 terms, and left every constraint untouched. It returned `''` for
LinkedIn and GitHub rather than inventing them, which is the designed behaviour.

## UI

| Field | Before | After |
|---|---|---|
| `terms`, `titles` | `UTextarea` + newline split | `UInputTags` — `modelValue` is `string[]`, chips have delete buttons |
| `onsiteCountries`, `willRelocate` | 8 hardcoded `UButton` chips | `UInputMenu multiple` — searchable dropdown *and* deletable chips inside the input |
| `cv` | `UInput` holding an absolute path | `UFileUpload` drop zone, plus a Prefill button |
| — | — | `UAlert` naming what is still missing, from `GET /api/settings/status` |

`USelectMenu multiple` was the obvious pick and is the wrong one: it renders the selection as joined
text. Only `UInputMenu` wraps reka's `TagsInputRoot`.

Completeness is computed server-side rather than in the page, because one of the answers — whether the
CV file is on disk — is not something the browser can know, and because it then has one definition.

## Two things the form gets right, non-obviously

- **The CV upload only moves `cv`.** It writes to the database outside the form, so both the form and
  the dirty baseline need updating — but adopting the whole stored config would throw away unsaved
  edits. Drop a CV after typing your name and the name would vanish. Only `cv` is copied onto the
  form; the baseline takes the whole response, which keeps `dirty` equal iff there were no other edits.
- **Prefill merges into the posted form, not the stored row.** The button promises "clear a field and
  it gets re-read from the CV". If the server merged into what it had stored, clearing a field without
  saving would do nothing and the button would silently no-op. The page posts `form.value`; the server
  validates it and merges into that, falling back to the stored row only if the body is malformed.
  `cv` is taken from the stored row either way — the browser does not get to name the file the server
  opens.

## Known gaps

- **`normalizeCountries` keeps a name it does not recognise** rather than dropping it. Deliberate:
  silently deleting a stored country on every save would be data loss. The consequence is that a typo
  entered before this change survives, and `tldsFor`/`withAliases` simply skip it.
- **Zod is not in the client bundle, but only because the page imports types.** If `settings.vue` ever
  imports a *value* from `#shared/settings`, Zod ships with it — `settingsSchema` is a side-effectful
  module-level const and will not tree-shake.
- **Prefill has no per-field review.** It fills blanks and you eyeball the form. A diff view with
  per-row accept was considered and deferred.
- **`patchConfig()` bases its merge on `readConfigLoose()`, which falls back to `emptySettings()` when
  the stored JSON fails `parseSettings`.** Unreachable today — only `writeSettingsTo` writes, and it
  validates first — but the first schema change that makes existing rows fail to parse would turn the
  next CV upload into a silent wipe. Any such change needs a migration of the row, not just the table.
- **The CV is stored under its uploaded name**, and older PDFs in `data/cv/` are removed on replace.
  There is no history.
