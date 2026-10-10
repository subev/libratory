# Phone shelf review, 2026-10-10

**Verdict: no bypass of the network guard found; one real correctness bug (the "books on phone" count), two low-severity design risks, a few rule nits. Safe to commit after fixing finding 1.**

Method: read every listed file; ran a throwaway probe (a Fastify app registering the guard first, then `@fastify/cors`, `@fastify/rate-limit`, two `@fastify/static` mounts, `registerSpaFallback`, with `remoteAddress: 10.0.0.5` and `NETWORK_ACCESS=shelf`) over GET/HEAD/OPTIONS/POST and the URL forms listed below. The probe file was deleted afterwards. Nothing in the repo was changed except this report.

## Findings (by severity)

### 1. Medium: "books on phone" counts files, not books
`packages/server/src/routes/phone.ts:75-81`: `count(documents.bookId)` with `groupBy(shelfDownloads.deviceId)` counts rows. The comment on line 74 says "a phone that fetched both editions of one book has one book". The test at `routes/phone.test.ts:88-103` builds exactly that case (two documents of one book, `a.book.id`) and asserts `["iPhone", 2]`, so the test enshrines the bug. The Phone page then prints "2 books" for one book (`PhonePage.tsx` PhonesCard).
Fix: `countDistinct(documents.bookId)` (import from drizzle-orm) and change the test expectation to 1.

### 2. Low: download is recorded before the file is known to exist
`shelf-routes.ts:~118-124`: `shelfDownloads` insert happens before `sendFile`. If the file is missing on disk (or `path.relative(outputDir, outputPath)` escapes the root and static refuses it), the caller gets an error but the owner's "On phones" column and the phone's `downloaded: true` flag already say it was fetched. Fix: check the file exists first (`fileSize(row.outputPath)` is already used in `shelf.ts`) and 404 otherwise, or record on `reply.raw` "finish". Also `content-disposition` is set before `sendFile`, so a failed send may leave it on the 404 JSON; harmless.

### 3. Low: the guard trusts the socket, so anything on the same machine in front of the server defeats it
`network-access.ts:62-65` reads `request.socket.remoteAddress`. A local reverse proxy or `tailscale serve`/`funnel` forwarding to 127.0.0.1 makes every remote caller loopback, which gets everything including tRPC. This is the intended design (and what the "don't read X-Forwarded-For" comment implies), but docs/shelf.md and `.env.example` should say plainly: do not front a `none`/`shelf` server with a local proxy; use `TRUSTED_HOSTS` + `all` behind a login instead.

### 4. Low (pre-existing posture, newly consequential): tRPC has no Host/Origin check, and two new mutations widen exposure
`phone.setNetworkAccess` and `phone.listenOnNetwork` (`routes/phone.ts:47-59`) persist `NETWORK_ACCESS=all` / `HOST=0.0.0.0` to `.env`. `main.ts` checks Host only for `/mcp` (`mcp-routes.ts:16`); `/trpc` relies on CORS. A DNS-rebinding page (Host `attacker.com`, resolving to 127.0.0.1) is same-origin to itself and arrives from a loopback socket, so the guard lets it through, and it could call `setNetworkAccess("all")` and `listenOnNetwork`, turning a drive-by into a persistent LAN-wide unauthenticated library after the next restart. Before this change the same page could already delete books, so this is a severity increase, not a new class. Fix: reject non-IP-literal, non-trusted `Host` on these two mutations (reuse `isTrustedHost` from `lib/cors.ts`), or on all of `/trpc`.

### 5. Low: pairing countdown can loop on a skewed clock
`PhonePage.tsx` `useCountdown` + the `expired` effect: remaining is `expiresAt(server) - Date.now()(browser)`. If the browser clock is 10+ minutes ahead of the server, `expired` is true on arrival, the effect invalidates, a new code is minted (`phone.pairingCode` mints on every read), and it is expired again, in a loop of refetches that each mint a token. Only reachable when the page is opened on a different machine (access `all`) or a badly set clock. Fix: return `ttlMs` from the server and count down from the moment of arrival. Related, cosmetic: `now` state is stale until the first 1 s tick after a code arrives (it only ticks while `until` is non-null), so the first second can show a slightly long time.

### 6. Nit: project rules
- `PhonePage.tsx` draws four inline notices (`px-3 py-2 rounded-md bg-(--warning-bg)` etc.). AGENTS.md says the notice role is confined to `DownloadNotice`, `ModelBundleNotice`, `UpdateProgress`; either extract one `Notice` or update that sentence.
- `PhonePage.tsx` `navigator.clipboard.writeText` is `void`ed with no catch (rejects on non-secure contexts, e.g. the page opened over plain LAN HTTP); show nothing or fall back.
- `shelf.ts` `languageName` builds `Intl.DisplayNames` per call (per row); trivial.
- `DEFAULT_PROFILE_ID` is imported on a second line from the same module in `routes/phone.ts`; merge with the `schema.ts` import.

No `any`, no `!` on indexed access, no hand-rolled icons (`IconPhone` is in `icons.tsx` and used), no `dark:` classes, no palette tokens, Button used everywhere, `status` unions handled with a `never` default in `editionLabel` and `networkMayReach`.

## Verified non-issues

Network guard (`lib/network-access.ts`, registered first in `main.ts:64`):
- Hook ordering: a root `onRequest` added before any `register` runs before the CORS preflight handling, `rate-limit`, `multipart`, both `static` mounts, the tRPC plugin, and the 404 handler. Probe confirmed: from 10.0.0.5 in `shelf` mode only `/shelf`, `/shelf?x=1`, `/shelf/pair/x` and `/shelf/pair/..%2f..%2ftrpc` (which is just a `:token` value, harmless) returned non-403, for GET and HEAD. POST and OPTIONS (including a CORS preflight to every path) returned 403 everywhere; `/`, `/a.js`, `/phone`, `/index.html`, `/files/`, `/trpc/x`, `/shelf/`, `//shelf`, `/shelf/nope`, `/shelf/pair/x/`, `/shelf/%2e%2e/trpc/x` all 403.
- Matched-route decision: static's wildcard registers as `/*` and cors' preflight as `*`, neither starts with `/shelf`; unmatched URLs reach the SPA not-found handler with `routeOptions.url` undefined, which is refused. `/shelf/` is not a shelf route (no `ignoreTrailingSlash` in `fastify-config.ts`) so 403.
- `routeUrl.startsWith("/shelf/")` can only be satisfied by the four routes registered in `shelf-routes.ts`; no other module registers a `/shelf*` path (grep).
- IPv6 forms: `::ffff:127.0.0.1` handled; `::ffff:7f00:1` (hex form) is not recognised as loopback, which fails closed. No trust of `request.ip`/`X-Forwarded-For`; Fastify `trustProxy` is not set anywhere.
- `remoteAddress` undefined (unix socket) is refused except in `all`.
- Loopback host binding (`HOST=127.0.0.1`) means the guard never sees remote traffic.

Shelf routes:
- Device key is the only credential: read from `Authorization: Bearer`, stored as sha256 (`hashDeviceKey`), 32 random bytes, unique index. No cookie read, so browser CSRF cannot ride a session. Unauthenticated callers get a uniform 401 on `/shelf` and `/shelf/documents/:id` (auth runs before id validation, so no uuid oracle).
- Token lifecycle (`lib/pairing.ts`): `peek` never spends, `spend` is synchronous so two concurrent POSTs cannot both win, ten-minute expiry checked at `lookup`, spent tokens swept on next mint, bound to the profile at mint. A token burned by a failed device insert is acceptable. `/shelf/pair/:token` reveals hostname, profile name and book count only to a token holder; 404 vs 410 distinguishes a never-minted from a used token, negligible with 24 random bytes. Pair endpoints are rate limited (`PAIR_RATE_LIMIT`, `global:false` plugin is registered in `main.ts`).
- Profile scoping: listing joins `books.profileId`; download checks `row.profileId === device.profileId`, `!hidden`, and format in the two shelf formats, else 404; `setHidden` and `forget` filter by caller profile; `devices` by profile; cascade deletes clean `shelf_downloads`.
- `sendFile`: the path comes from the DB row, not the request; `:documentId` is validated as a uuid. A path outside `outputDir` would produce a `../` relative that `@fastify/static` refuses.
- Drizzle queries and the migration (`0047`) match `schema.ts`; `inArray` with an empty list is guarded in `shelfDocuments` and `devices` (early returns).
- Web: `LibraryHeader` extraction dropped nothing (settings modal state moved with it, `IconBook`/`IconSettings`/`Button`/`ProfileSwitcher`/`ThemeToggle`/`AssistantToggle` all accounted for; the only addition is the Phone link). `CLIENT_ROUTES` has `/^\/phone$/` matching `main.tsx`. `ProfileSwitcher` invalidates all queries on switch so the profile-less query keys on the Phone page refetch. Effect dependency arrays in `PhonePage.tsx` are correct and contain no inline functions; `staleTime: Infinity` plus invalidate-on-expiry behaves as designed.

## Test gaps

- Add a real-composition guard test (guard + cors + both static mounts + `registerSpaFallback`) like the probe above; `network-access.test.ts` uses a bare app, so a future reordering in `main.ts` (e.g. registering the guard after cors) would not fail any test. Smallest fix: export a `registerHttpPlugins(fastify)` from `main.ts` and test it, or at least a test asserting the hook is the first `onRequest`.
- Missing-file download: no test that a document whose file is gone returns 404 and records no download (see finding 2).
- No test for `setNetworkAccess`/`listenOnNetwork` being refused for a foreign Host (finding 4).
- `pairingCode` is tested for the happy and `none` paths but not for `access: "all"` returning a code, or for `HOST` values like `127.0.0.2`/`::1` (`LOOPBACK` is an exact-string set, so `127.0.0.2` counts as network-bound; it fails safe by showing a code).
- Phone page: no test for the expiry/refetch loop.
- Shelf `/shelf` response does not carry a test for `includeHidden: false` with a hidden sibling edition of a visible book (covered indirectly in the download test only).
