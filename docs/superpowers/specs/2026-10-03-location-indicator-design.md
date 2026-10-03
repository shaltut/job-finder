# Location indicator — design

**Date:** 2026-10-03 · **Status:** approved in chat

## Problem

The Posts view shows where a job is only as a grey, truncated line under the title (`company · location`)
and a *remote* / *in scope* chip pair. `posts.location` is the scoring model's free text: measured
2026-10-03 over 2,037 hiring posts, **852 distinct strings** ("Bangalore", "Bengaluru", "Bengaluru, India"
are three). The owner wants one clear, standardized indicator per row.

## Measured (2026-10-03, hiring posts)

- `countriesIn()` resolves 1,651 (81%) to one country, 20 to several, 366 to none: 126 bare "remote",
  107 "unknown", ~111 genuine misses — US states spelled out ("Austin, Texas"), Indian cities not in the
  city table (Jaipur, Vadodara, Coimbatore, Nagpur, Bhopal, Trivandrum), "Toronto, ON", Lagos, Arabic
  country names, regions ("Middle East", "APAC", "Southeast Asia").
- In the posts the owner reads (score ≥ 6, not dismissed: 237) **38% show no country** — 56 "remote",
  17 "unknown" — and unlocated posts score higher on average (3.34 vs 2.34).
- Remote is two things: 156 remote with no place, 121 remote restricted to a country ("Remote (India)").
- Work model: the location field names one in 376 posts; **583 state it only in the post body**.
- `remote` flag set on 60 posts whose location text does not say remote (the scorer read the body).
- Weak signals, not used for the answer: the body names a country in 53 of 240 unlocated posts, the
  email TLD in 15, a phone code in 9; the email TLD **disagrees** with the stated location in 20 posts
  (the agency's country, not the job's).
- Bug: "Atlanta, Georgia" resolves to the country Georgia (2 rows among the score ≥ 6 posts).

## Design

`shared/place.ts` — pure, browser-safe, beside `shared/countries.ts`:

```ts
export interface Place {
  countries: { name: string, flag: string }[]   // resolved, in mention order; [] when none
  city: string | null                           // canonical spelling ("Bengaluru"), null when none
  region: string | null                         // "Middle East", "APAC", ... when no country resolves
  mode: 'remote' | 'hybrid' | 'onsite' | null
  modeFromText: boolean                         // mode came from the post body, not the location
  stated: boolean                               // false for empty / "unknown" / "not specified"
}
export function placeOf(location: string | null, body: string | null, remoteFlag: boolean | null): Place
```

- Countries: `countriesIn()` (improved below), flag from the ISO alpha-2 code (regional-indicator pair).
- Work model, first match wins: the location text (remote / hybrid / on-site words) → `remoteFlag` →
  the post body, **hybrid and on-site only** (a bare "remote" in a body is too noisy — "remote team",
  "remote access"); body-derived sets `modeFromText`.
- Computed in `server/api/posts.get.ts` per returned row (≤ 100 rows a page) and returned as `place`.

`shared/countries.ts` improvements (filter and display both read `countriesIn()`, so they stay in step):
- Full US state names; a US state (abbreviated or full) **wins over the country Georgia** when the text
  also carries a state context ("Atlanta, Georgia" → USA; "Tbilisi, Georgia" stays Georgia).
- More cities in the filter-only `CITY_COUNTRY` table from the measured misses; Canadian province codes.
- Arabic country names as aliases of their country (المملكة العربية السعودية, مصر, الإمارات, قطر).
- Regions are a separate small table and never become a country.
- The `CITY_COUNTRY` rule stands: city and region names never reach `withAliases()`, `nameFormsFor()` or
  any prompt.

UI — the **Where** column becomes **Location**, keeping its header filters (scope, country, exclude):

```
🇸🇦 Saudi Arabia      🇮🇳 India               🌐 Remote · anywhere    ❔ Not stated
Riyadh · On-site      Remote (India only)     in scope                 Hybrid (from post text)
```

- Line 1: flag + country; several → first + "+N" with the full list in `title`; none + remote →
  "🌐 Remote · anywhere"; region → "🌍 Middle East"; nothing → "❔ Not stated".
- Line 2: city · mode chip; a country-restricted remote reads "Remote (India only)"; body-derived modes
  carry "(from post text)". The *in scope* chip stays.
- The subtitle under the title keeps the company only (the location moves to its own column).

## Not doing

- No email-TLD or phone-code inference in the answer (measured unreliable; 20 disagreements).
- No migration, no rescore, no new model call.

## Verification

`test/place.test.ts` — Georgia, Remote (India), bare remote, unknown, hybrid from body, Arabic, a region.
Before/after: resolution rate over all hiring posts and over score ≥ 6, printed by a script, both
reported. Screenshot of the Posts view.
