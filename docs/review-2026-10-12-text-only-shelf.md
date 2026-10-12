# Text-only shelf export review

Reviewed the six-file shelf fix against parent `78830cb`. No blocking findings.
Unrelated working-tree changes and the rest of the outgoing branch were not reviewed.

## Evidence

- `packages/server/src/lib/shelf.ts:12-13`: plain EPUB joins the same allow-list used
  for listing and pairing counts; PDF remains excluded.
- `packages/server/src/lib/shelf.ts:73-95`: original, translated and unknown-language
  text-only editions get appropriate labels, and downloads reuse the format guard.
- `packages/server/src/lib/shelf.ts:118-126`: profile/visibility filtering and export
  timestamp ordering remain intact. Grouping preserves that ordering.
- `packages/server/src/shelf-routes.ts:132-145`: the download route retains profile,
  visibility and file-presence checks while accepting plain EPUB.
- `packages/server/src/shelf-routes.test.ts:205-232`: regression exercises a new plain
  EPUB on an older book, a text-only book, pairing counts, download, hidden and foreign files.
- Phone page copy and `docs/shelf.md` match the expanded listing.

## Reproduction and verification

The reported book `36f42d65-636f-4661-a2a9-bf01d2a3beab` has a visible plain EPUB
created at `2026-10-12T12:07:42.599Z`. The previous shelf allow-list excluded it,
leaving September 29 as the latest visible edition. Refresh could not change that.

`pnpm lint` passed with existing warnings; `pnpm typecheck` passed; `pnpm test`
passed: 1,137 server, 166 web and 46 desktop tests (1,349 total).

The iOS source accepts format as a string and sorts by the maximum edition creation
date. No phone-device test was run. The installed desktop server is still the old
binary and needs a rebuilt app; the existing EPUB does not need regenerating.
