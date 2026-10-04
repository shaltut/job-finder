# Job Finder clipper

A "+ Job Finder" button on every LinkedIn post. One click sends the post — its full text, its author and,
when LinkedIn exposes it, its link — to your local Job Finder's **Paste a post** intake, which scores it
like any scraped post.

## Install (once per machine)

1. Start Job Finder (`npm run dev`). **The first time after pulling this, stop and start it once** — the
   server's new request guard is only picked up on a full start.
2. Chrome → `chrome://extensions` → switch on **Developer mode** → **Load unpacked** → choose this
   `extension/` folder.
3. The ID shown must be `pdoeglcbbgfjnonkfjpdgbeonopkoipo`. It is pinned by the `key` in `manifest.json`,
   and the server admits only this ID.

## Use

Open your LinkedIn **feed** or a **post search**, press **+ Job Finder** on a post. (Buttons appear only
there — on a single post's own page the comment list looks like a list of posts.) The button then says:

| Label | Meaning |
|---|---|
| ✓ Added | queued for scoring; it appears in Posts under search term `clipped` |
| Already have it | the scraper or an earlier click stored this post |
| No contact route (email only) | the post carries none of the contact routes switched on in Settings |
| Job Finder not running | nothing answered on 127.0.0.1:3939 |
| Job Finder refused this extension | the extension ID does not match — reload it from this folder |

It never clips by itself and never reads your clipboard.
