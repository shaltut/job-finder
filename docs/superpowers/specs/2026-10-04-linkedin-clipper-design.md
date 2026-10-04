# LinkedIn clipper extension — design

**Date:** 2026-10-04 · **Status:** approved in chat

## Problem

The owner browses LinkedIn in their own Chrome and sees posts worth applying to that no scrape term
caught. Today that means select the post, copy, switch to the Posts view, paste into **Paste a post**.
They want one button on the post itself.

## Design

### 1. The extension — `extension/` in this repo

Manifest V3, plain JavaScript, no build step, loaded with **Load unpacked** on each machine.

- `manifest.json` — `content_scripts` on `https://www.linkedin.com/*`; `host_permissions` for
  `http://127.0.0.1:3939/*` (the background worker's fetch then needs no CORS); a public `key` so the
  extension ID is the same on every machine that loads it (the server's origin guard pins that ID).
- `content.js` — finds post cards structurally, as `readCards` in `scraper/lib.ts` does (LinkedIn's class
  names are hashed): a container whose children each hold an author link. LinkedIn renders lazily, so a
  `MutationObserver` adds the button to cards as they appear; a `data-` marker prevents a second button.
  On click:
  1. expand the card's "…more" — both labels the scraper knows (`…more`, `…المزيد`), clicked, then wait
     for the text to grow;
  2. read the card's `innerText` (the same text a scrape stores, header included — so the key matches);
  3. author link = the **most repeated** `/in/` or `/company/` href in the card (the scraper's rule: the
     real author is linked three times, a resharer twice); author name = that link's text;
  4. post link = the first card href matching `/feed/update/urn:li:` or `/posts/`, else none — LinkedIn
     strips URNs from much of the DOM (CLAUDE.md, permalink gotcha), so this is best-effort;
  5. send `{ text, author, authorUrl, postUrl }` to the background worker.
  The button shows the outcome in place: **✓ Added** · **Already have it** · **No contact route
  (email only)** — naming the channels enabled in Settings · **Job Finder not running** · the server's
  error text otherwise.
- `background.js` — `POST http://127.0.0.1:3939/api/posts/paste` with the payload, returns status + JSON.

Nothing in `extension/` names the owner (`test/identity.test.ts` scans tracked files).

### 2. The paste endpoint — optional provenance

`server/api/posts/paste.post.ts` body gains optional `author`, `authorUrl` (must be a `linkedin.com` URL)
and `postUrl` (same).

- With `authorUrl`, the gate's key is `dedupeKey(authorUrl, text)` — the scraper's own key — so a post
  the scraper already stored reads **Already have it**, and a later scrape of a clipped post is
  recognised instead of stored twice. Without it, unchanged: `dedupeKey('', text)`.
- The row's `search_term` is `'clipped'` when `authorUrl` is present, `'pasted'` otherwise; `author`,
  `author_url`, `post_url` are stored. `CLIPPED_TERM` sits beside `PASTED_TERM` in `server/utils/paste.ts`.
- `stats.get.ts`'s two scrape figures (`last24h`, `scrapedAt`) exclude both terms — they measure the
  scraper. The yield table gives `clipped` its own row, as it does `pasted`.
- The paste lane, the gate, scoring, flags and every email-deciding query are unchanged: a clipped post
  scoring 4 does not draft, exactly like a scraped one.

### 3. Origin guard — `server/middleware/origin.ts`

Today no middleware exists: the server binds 127.0.0.1, but any web page in the browser can send it a
"simple" cross-site POST. The extension is a cross-origin caller by design, so the guard comes with it:

- For `POST` / `PUT` / `PATCH` / `DELETE` under `/api/`: allow when `Origin` is absent (curl, server-side
  calls), equals the app's own origin (`http://127.0.0.1:3939`, `http://localhost:3939`), or equals
  `chrome-extension://<EXTENSION_ID>`. Anything else → 403.
- GETs are untouched — the Gmail OAuth callback is a cross-site GET and is guarded by its own nonce.
- The decision is a pure function `originAllowed(method, path, origin)` in `server/utils/origin.ts`, so a
  test can reach it (no test can import a Nitro handler).
- A new `server/middleware/` directory is only scanned when the dev server starts: **a full restart of
  `npm run dev` is required once** (the plugins gotcha in CLAUDE.md).

## Not doing

- No clipboard access, no reading LinkedIn's network payloads, no automatic clipping — one click, one post.
- No Chrome Web Store packaging.

## Tests and verification

- `test/origin.test.ts`: same-origin, absent origin, the extension ID, another extension, a LinkedIn page,
  a GET from anywhere, a non-`/api` path.
- `test/paste.test.ts`: with `authorUrl` the key equals `dedupeKey(authorUrl, text)` and the record carries
  `clipped` and the provenance; without it nothing changes; a non-LinkedIn `authorUrl` is refused.
- Extension: `extension/lib.js` holds the pure parts (most-repeated author href, post-link pick, result
  label) and `test/extension.test.ts` imports them.
- Live, by the owner: load unpacked, open the feed, click the button on a post with an email, see
  **✓ Added**, then the post appears in Posts under search term `clipped`; click again → **Already have it**.
