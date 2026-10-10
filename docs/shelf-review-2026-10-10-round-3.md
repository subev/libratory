# Shelf review, round 3: the public case (2026-10-10)

Scope: the uncommitted public-shelf hunks only. Ran `vitest run src/shelf-routes.test.ts src/routes/phone.test.ts src/lib/shelf.test.ts`: 26 passed.

## Verdict
No credential bypass found. Reachable without a key is exactly the public profile's visible, shelf-format, non-hidden files plus its profile id/name. Two medium issues (unauthenticated write amplification, a page that claims "public" when the network guard refuses everything) and a few lows.

## Findings

### Medium
1. Every unauthenticated download inserts a row, with no rate limit.
   `shelf-routes.ts:132-135` inserts into `shelf_fetches` per request; `/shelf` and `/shelf/documents/:id` carry no `config.rateLimit` (only the two pair routes use `PAIR_RATE_LIMIT`, `shelf-routes.ts:58`, `request-limits.ts:7`). Anyone who knows the address can grow the table without bound (the file is also streamed each time), and the "Downloads" count is trivially inflatable. Fastify also exposes HEAD for GET routes, so a HEAD (no body) runs the handler and records a fetch too (not run, framework default). Fix: a rate limit on both public routes, and consider recording on GET only.
2. The Phone page says "This shelf is public" when nothing can reach it.
   `PhonePage.tsx:89-99` puts the `isPublic` branch first in the ternary, ahead of the `loopbackOnly` (`:100`) and `access === "none"` (`:117`-ish) notices. With `PUBLIC_SHELF_PROFILE` set and `NETWORK_ACCESS=none` (the laptop default, `network-access.ts:14`) or a loopback `HOST`, the guard answers 403 to the network (`network-access.ts:42-52`), yet the owner is told "every reader that knows this server's address lists it". Wrong either way: the owner may believe it is live when it is not. Fix: compute public-and-reachable (`access !== "none" && !loopbackOnly`) and show the other notice too.

### Low
3. A stale `PUBLIC_SHELF_PROFILE` is never cleared.
   Deleting the profile leaves the id in `.env`; `/shelf` then answers 401 "This shelf is gone" (`shelf-routes.ts:103`) and, if the id were ever reused, would silently become public. `publicShelfProfileId()` (`lib/shelf.ts:37-41`) does no validation either (`z.string().optional()`, `env.ts:43`, not a uuid check). Clear it in `profiles.delete`, and validate with `isUuid`.
4. `setPublic` is reachable by DNS rebinding, like every other mutation.
   `phone.ts:58-65` has no auth beyond `x-profile-id`. CORS (`cors.ts`, `main.ts:67-69`) blocks a cross-site page from reading or preflighting, but there is no Host check on `/trpc` (only on `/mcp`), so a rebound `attacker.com` page (same-origin to itself) can POST `{public:true}`. Pre-existing class (`secrets.set` has it), but this mutation's effect is publishing a library, and the page is not the only caller. Mitigations: `isTrustedHost` on `/trpc`, or refuse `setPublic` when the request has a non-loopback Host. I did not try a text/plain simple-request CSRF; the object input needs JSON, so I expect a 4xx.
5. Anonymous header values are client-supplied.
   `countryOf` (`shelf-routes.ts:52-55`) trusts `CF-IPCountry` from any caller if the server is reached without Cloudflare in front (spoofable, so "country" is only meaningful behind the proxy). The UA is cut to 200 chars (`:134`) but otherwise arbitrary. Not rendered anywhere, so no XSS; documented as analytics, which fits.
6. Empty or non-Bearer Authorization is treated as no key.
   `authenticate` (`shelf-routes.ts:36-46`) gives `key = ""` for `Basic x` or `Bearer ` (trailing spaces trimmed), so these get the public shelf instead of a 401. Harmless (public data) but differs from the "wrong key is 401" wording in `docs/shelf.md`; say "a wrong Bearer key".
7. Toggling invalidates `pairingCode`, which mints a fresh token each read (`phone.ts:23`-ish comment). Harmless; tokens expire.

## Verified non-issues
- Wrong or forgotten Bearer key stays 401 even when public: `if (publicProfile && !key)` (`shelf-routes.ts:46`) and the test at `shelf-routes.test.ts:150`.
- A device key for profile A cannot read public profile B: `profileId` comes from the device (`:42`), and the document check compares `row.profileId === caller.profileId` (`:124`); the test at `:145-148` covers the listing.
- Hidden documents and non-shelf formats are 404 for the public (`:124-125`, `includeHidden: false` at `:104`). Other profiles' files are 404 (test `:152-153`).
- The listing leaks neither device names nor `fetches`: `groupByBook` (`lib/shelf.ts:174-196`) only copies the fields in `ShelfBook`. It does expose profile id and name (`shelf-routes.ts:107`); the id is not a secret in this app's model but is the `x-profile-id` scope, so it matters only on `NETWORK_ACCESS=all`, where the whole library is already open.
- NETWORK_ACCESS guard unchanged and still decides first: `none` blocks `/shelf` from the network, `shelf` lets only `/shelf*` through, so public mode does not widen tRPC. Behind a loopback proxy the guard passes everything (pre-existing).
- Pairing, pair-peek and Phone page are untouched and still need the owner's UI; the Phone page is the web app, not a `/shelf` route.
- `groupByBook(null)`: `downloaded` is false (`lib/shelf.ts:192`), tested (`shelf.test.ts:66`).
- Fetch count query (`lib/shelf.ts:130-137`) is skipped for an empty list, groups per document, and `count()` is a number in drizzle.
- `setPublic(false)` clears only its own profile (`phone.ts:63`), tested (`phone.test.ts:117-118`).
- Analytics identity: stored are document id, UA, two-letter country, timestamp. No IP, cookie or install id (`schema.ts:360-366`); Fastify's request log may still hold the IP, which is outside this table. The reader UA (`Libratory-Reader/<v> (iOS <os>; <model>)`) is low-entropy.
- Rules: no `!`, `any`, or interfaces; `Caller` is a `type`; no narrating comments beyond one-liners; spacing and tokens on the ladder (`gap-2`, `px-3 py-2`, `--warning-bg`); both confirm() calls follow the destructive-confirm convention (making public is guarded more than making private, which is right). Migration 0049 matches `schema.ts` (cascade FK, no extra columns).

## Test gaps
- No test that `/shelf` is 401 with no key when `PUBLIC_SHELF_PROFILE` is unset (the 401 test may cover it; the public suite only tests the set state). Add the explicit pair.
- No test for a stale or deleted public profile id (finding 3) and none for `Bearer ` with empty key (finding 6).
- No test that a hidden document is 404 for a public caller (only a foreign profile's is).
- No test that the `/shelf` listing carries no `fetches` or device names for the public.
- No test that a missing file records no fetch (`access` check precedes the insert, `:128-129`, but is untested for the public branch).
- `PhonePage` has no test for the public/private states or for the confirm cancel path; `isPublic` with `access:"none"` (finding 2) is exactly the case to pin.
- No rate-limit test (finding 1).
