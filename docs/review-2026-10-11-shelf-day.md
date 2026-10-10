# Review: shelf day (3919be1^..HEAD), 2026-10-11

Scope: the 12 commits listed by `git log 3919be1^..HEAD`, committed code only. Read-only review;
the one experiment run was a throwaway zip in the scratchpad. Nothing was stamped.

## Findings, ranked

### 1. Medium: duplicate zip member names bypass the "declared vs actual" size check
`packages/server/src/lib/synced-epub-books.ts:44-52`, `:234-241`.
`listEntries` stores entries in a `Map` keyed by name, so a second entry with the same name overwrites
the first. `unzip -p epub name` (`:78`) streams EVERY member with that name, concatenated. The guard
at `:235-237` therefore counts one entry's size while `extractEntry` writes all of them.
Reproduced: a zip with three members named `a.m4a`, 1,000,000 zero bytes each, 3,235 bytes on disk.
`unzip -l` lists three; the Map holds one (1,000,000); `unzip -p dup.zip a.m4a | wc -c` gives 3,000,000.
Scenario: a 1 MB archive holding ~300 deflated duplicates of a ~1 MB audio member declares 1 MB
(<= 4x the file), passes, and writes ~300 MB to `ch000.m4a` (about 1000x deflate ratio is available).
The same duplicate also makes `p2af/book.json` or a cue file read as concatenated JSON (fails, so only
the audio path matters). Fix: reject listings with a repeated name (count lines vs Map size), and/or
sum declared sizes over the listing lines, not the Map.

### 2. Medium: imported audio keeps the archive's file extension, and `/files/*` serves the output dir
`synced-epub-books.ts:225` (`path.posix.extname(audioEntry)`) writes
`data/output/<bookId>/ch000<ext>`; `main.ts:75` statically mounts the output dir at `/files/` with
no content-type restriction. A hostile "read-along EPUB" whose manifest says `audio: "x.html"` (or
`.svg`) puts attacker HTML at `/files/<bookId>/ch000.html`, same origin as the unauthenticated tRPC
and MCP API. It needs the victim to import the file and open that URL (the book id is not
guessable by the sender, so it is not drive-by), which is why this is Medium and not High. Fix: allow
only `.m4a|.mp3|.wav|.m4b` (fallback `.m4a`) before building `audioPath`. No test covers it.

### 3. Medium: public shelf behind a proxy shares one rate-limit bucket for the world
`packages/server/src/shelf-routes.ts:73,89,105,119` use `SHELF_RATE_LIMIT` (120/min) and
`PAIR_RATE_LIMIT`; `main.ts:71` registers `@fastify/rate-limit` with no `keyGenerator` and there is
no `trustProxy` (grep: none). The key is `request.ip`, i.e. the socket address. The documented
public deployment (docs/shelf.md:199, `PUBLIC_ORIGIN` behind a proxy) makes every visitor the
proxy's address: 121 requests/min from one client yields 429 for every reader and for the owner's
pairing (60/min on `/shelf/pair`). Fix: key on `CF-Connecting-IP`/first `X-Forwarded-For` only when
`PUBLIC_ORIGIN` is set, or document it. The guard itself correctly ignores forwarded headers, so do
not use `trustProxy` globally.

### 4. Low: a HEAD from a paired device counts as a download
`shelf-routes.ts:144-146`. For `caller.device` the insert has no `startsDownload(request)` check
(the public branch has it at `:147`), although its comment says "a HEAD that only sizes it is the
same download continuing". Fastify exposes HEAD for GET routes, so `HEAD /shelf/documents/<id>` with a
valid key writes `shelf_downloads`, and the owner's "on phones" column shows the book as fetched with
no bytes sent. Test `shelf-routes.test.ts:169` covers only the public branch.

### 5. Low (documented): any same-machine reverse proxy removes the NETWORK_ACCESS guard
`network-access.ts:37-38` treats a loopback socket as the owner. docs/shelf.md:145-147 says so. It is
still the sharpest edge of the design: the desktop "Make it public" path plus a local `cloudflared`
or `tailscale serve` exposes `/trpc`, `/mcp`, `/api` and uploads unless the proxy filters paths.
No code finding; consider having `setPublic` refuse (or warn) unless `NETWORK_ACCESS !== "all"`
is consciously chosen, or ship the proxy path allow-list in the deploy files.

### 6. Low: translation lane sums every translation of a chapter
`synced-epub-books.ts:172-187`. `ch.bilingual` can hold several pairings (one per translation key);
each adds its `totalMs` to one `translation` lane and its voices to one set, while
`documentFormatOf` (`synced-epub.ts:~74`) names only the first key. A two-translation export shows a
duration of the sum and a mixed voice list on the shelf row.

### 7. Low: pairing-code docs claim vs boot order
`main.ts:289-297`. The new comment says failing on the port "touches nothing", but `migrate` (`:285`)
and `sweepStaged` (`:289`) still run before `listen`. Both are idempotent, so no demonstrated harm;
the comment is slightly overstated. Moving `listen` before them is not possible (routes would answer
before the schema exists), so just soften the comment.

### 8. Low: `isVirtual` regex is unanchored at the end
`reachable-address.ts:14`. `^(...|ap)\d*` matches any interface name that merely begins with `ap`,
`tap`, `tun`, `br-`, `bridge`, `llw`. Linux names like `apcli0` or a USB NIC named `tunnelbr0` are
dropped from the pairing list. Link-local `169.254.x.x` addresses are not filtered (an Ethernet port
with no DHCP is offered as a LAN fallback). Fix: `/^(bridge|vmnet|utun|tun|tap|docker|veth|br-|virbr|awdl|llw|ap)\d*$/`
adjusted for `br-<hash>` and skip 169.254/16.

### 9. Low: `drop_stale_chunks` does nothing when the manifest is unreadable
`scripts/chunk_fit.py:77`. If `chunks.json` is missing or corrupt, `cached_chunk_texts` returns `[]`
and the function returns early, so `chunk-NNN.wav` files from an older cut are reused by index under
the new text. Synthesis normally deletes the dir once the sync map exists, so this needs an
interrupted run plus a lost manifest; cheap fix: when `cached_texts` is empty, remove every
`chunk-*.wav`/words file in the dir.

## Simplification

- Dead in production (tests only): `pickReachable`, `reachableAddress`, `Reachable` type
  (`reachable-address.ts:6,52,102`) and `shelfAddress` (`shelf-address.ts:25`). Callers moved to the
  list form; delete them and their tests.
- `shelfBookCount` (`shelf.ts` end) runs `shelfDocuments`, which stats every file and runs two extra
  queries, only to count distinct books. It is called on the pre-pairing peek and on pair. One
  `count(distinct books.id)` query does it.
- `shelf-routes.ts:84-90` and `:109-111` build the same `addresses.map(({origin, via}) => ...)`;
  `via: addresses[0]?.via ?? "lan"` duplicates `addresses[0]`. A small `describeAddresses()` helper.
- `routes/phone.ts:18` keeps its own `LOOPBACK` set beside `network-access.ts:isLoopbackAddress`; they
  disagree (`localhost` vs literal-IP check) and should share one.
- `attachSyncedEpubDocument` and `createSyncedEpubBook` both do list, find manifest, freePath, narration,
  summary strings; the "1" / "1-N" chapterSummary expression appears three times in the file.
- `narrationFromLayer` repeats the same four lines (levels, ms, voice) for original-from-pairing and
  translation (`:176-187`); one `add(side, narration)` helper removes both.
- Comments restating code: `p2af.ts:35-39` (the rationale paragraph is good, the "six of 73" anecdote
  belongs in the commit), `synced-epub-books.ts:75-76`, `shelf-routes.ts:16-19` header.

## Checked and found fine

- Guard (`network-access.ts`): decides on `routeOptions.url`, so `/shelf/../trpc`, `/SHELF/x`, encoded
  slashes, unmatched URLs, `OPTIONS *` preflights and the `/files/*` mount all get 403 under `shelf`;
  `::ffff:127.0.0.1` handled; socket address only; the hook is registered before CORS and plugins and
  is inherited by child scopes. HEAD shares the GET route url.
- `authenticate`: an offered credential must match a device; wrong/empty/non-Bearer gives 401 and
  never falls through to the public profile; only no header at all is public. Keys are 256-bit,
  stored as SHA-256. Forget takes effect on the next call.
- Pairing lifecycle: `spend` is synchronous so two concurrent spends cannot both win; peek never
  spends; expiry and sweep are consistent; token is 192 bits; bound to the minting profile.
- Download route: uuid check, profile check, hidden check and format check before the file is touched;
  `sendFile` is given a path relative to `outputDir`; counting happens only after `access()` succeeds.
- Attach path: `isUuid`, same-profile check, row inserted before the move with rollback on failure,
  temp dir removed on both outcomes; the catch's `deleteBook(bookId)` targets the fresh id, never
  `fields.bookId`.
- Unzip use: `execFile`/`spawn` with an argument array (no shell), `member()` escapes glob characters,
  output paths are built from `chapterFile(index, ext)` in the book's own dir, never from member names,
  so there is no path traversal into the data dir. `layerEntryPath` only selects which member to read.
  Text members are bounded by `maxBuffer` 64 MB.
- `p2af.ts:63-65`: the filter only runs when `pages.length === 0`, which after the `sources.length > 0`
  early return means a no-PDF book; a book with pages is untouched (tests at `p2af.test.ts:29,109`).
- Import narration merge: `originalLane` keeps measured level/duration and borrows only the voice label.
- `chunk_fit.py`: recursion terminates (halves are strictly shorter, `_hard_cut` is the base case); the
  espeak and English branches keep `chunk_espeak` equal to the old behaviour for unsplit chunks.
- Pairing-code LAN list: Tailscale first, tailnet address dedup, CGNAT range correct (100.64/10).

## Verification gaps

- No test for a duplicate-named or hostile-extension member in `synced-epub-books.test.ts`.
- No test that `POST /upload/ebook` with `bookId` refuses a foreign profile's book, an invalid uuid
  (400 path at `upload-routes.ts:138-141`), or leaves no temp dir.
- No guard test for HEAD or OPTIONS under `shelf`, and none for a device-key HEAD on a document.
- Rate limiting behind a proxy is untested (the bucket-sharing in finding 3 was reasoned from
  `main.ts`, not reproduced against a running server).
- Not run: vitest, lint, typecheck; no running server or Postgres was used. The web changes (app bar,
  Phone page) and `docs/shelf.md` claims beyond lines 140-147 and 199 were not reviewed line by line.
- Finding 2 is derived from reading `main.ts:75` and the extension logic; the file was not served.
