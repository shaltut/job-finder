# LinkedIn clipper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** a "＋ Job Finder" button on each LinkedIn post that sends it, with its author, into the paste intake.
**Spec:** `docs/superpowers/specs/2026-10-04-linkedin-clipper-design.md`
**Architecture:** MV3 extension (content script + background worker, no build) → `POST /api/posts/paste` with
optional provenance → the existing paste lane. A new origin guard admits only the app and this extension.

## Global Constraints
- No build step; plain JS in `extension/`. Pure extension logic in `extension/lib.js` (ESM) so tests import it.
- Nothing in tracked files names the owner (identity test).
- Check `/api/job` lanes idle before any `server/` / `shared/` edit.
- The origin guard is a pure function in `server/utils/origin.ts`; the middleware only applies it.
- `server/middleware/` needs one full `npm run dev` restart — the owner does it; say so.

## Review Focus
1. A cross-site page POSTing `text/plain` to `/api/posts/paste` → 403. (O1 test)
2. The Gmail OAuth callback (cross-site GET) still works → GETs never guarded. (O1 test)
3. A clipped post the scraper already stored → "Already have it" (same key). (P1 test)
4. `authorUrl` not on linkedin.com → refused 400, never stored. (P1 test)
5. Button injected twice on re-render → marker attribute prevents it. (E2 by inspection + live)

### Task O1: origin guard
**Files:** create `server/utils/origin.ts`, `server/middleware/origin.ts`, `test/origin.test.ts`.
**Produces:** `EXTENSION_ID: string`; `originAllowed(method: string, path: string, origin: string | undefined): boolean`.
- [ ] Failing test: GET anywhere → true; POST `/api/x` no origin → true; `http://127.0.0.1:3939` / `http://localhost:3939` → true;
  `chrome-extension://${EXTENSION_ID}` → true; another `chrome-extension://…` → false; `https://www.linkedin.com` → false;
  POST to a non-`/api/` path → true.
- [ ] Implement; middleware: `if (!originAllowed(...)) throw createError({ statusCode: 403, message: 'cross-site request refused' })`.
- [ ] Generate the extension key pair once (Node `crypto.generateKeyPairSync('rsa', 2048)`), public key DER base64 → `extension/manifest.json` `key`;
  ID = sha256(DER) first 32 hex chars mapped 0-f → a-p. The private key is not needed for an unpacked extension — discard it.
- [ ] Tests pass; commit.

### Task P1: provenance on the paste intake
**Files:** `server/utils/paste.ts`, `server/utils/paste-job.ts`, `server/utils/jobs.ts` (JobArgs + paste dispatch),
`server/api/posts/paste.post.ts`, `server/api/stats.get.ts`, `test/paste.test.ts`.
**Produces:** `CLIPPED_TERM = 'clipped'`; `interface Provenance { author?: string, authorUrl?: string, postUrl?: string }`;
`pasteGate(text, config, prov?)`, `pasteRecord(text, config, gate, score, prov?)`, `pasteOnce(text, config, deps, push, prov?)`,
`runPasteJob(text, push, prov?)`.
- [ ] Failing tests: with `authorUrl` the gate key === `dedupeKey(authorUrl, text)`; record has `searchTerm: 'clipped'`, author fields;
  without prov unchanged (existing tests). Endpoint schema refuses a non-linkedin `authorUrl` (zod `refine` on `new URL().hostname`).
- [ ] Implement; enqueue `('paste', { text, author, authorUrl, postUrl })`; stats exclude both terms.
- [ ] Tests, typecheck; commit.

### Task E1: extension pure logic
**Files:** create `extension/lib.js`, `test/extension.test.ts`.
**Produces:** `authorOf(hrefs: {href, text}[]): {url, name} | null` (most repeated `/in/` or `/company/`, query stripped);
`postLinkOf(hrefs: string[]): string | null`; `resultLabel(status: number, body: object): {text, tone}`.
- [ ] Failing tests (repost case: resharer twice, author three times → author), then implement; commit.

### Task E2: extension shell
**Files:** create `extension/manifest.json`, `extension/content.js`, `extension/background.js`, `extension/README.md`.
- [ ] content.js: find cards (element whose direct children each contain a profile link — mirror `readCards`), MutationObserver,
  `data-jf-clip` marker, click → expand "…more" / "…المزيد", wait up to 1.5 s for text growth, collect, message background, render label.
- [ ] background.js: fetch, return `{ status, body }`, map network failure to status 0.
- [ ] Docs: SETUP.md "Clip from LinkedIn" (load unpacked, the one restart), CLAUDE.md pipeline bullet + gotchas.
- [ ] Commit. Owner verifies live (spec's verification list).
