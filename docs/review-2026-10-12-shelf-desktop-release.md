# Shelf and desktop editing release review

Reviewed the complete outgoing change from `78830cbff4aa6c626751a8e97a3a6d8949c5127e`
through the shelf commit and desktop editing fix, including both new desktop files,
tests, UI copy and both review reports. No blocking findings. No merge resolutions.
Unrelated changes in the original checkout are excluded from this release.

## Findings and evidence

- `packages/server/src/lib/shelf.ts:12-13,73-95,118-126,189-224`: plain EPUBs share
  the listing/count allow-list, receive text-only labels and keep export-date ordering.
  The grouping preserves newest-first order. Null narration reports no recording.
- `packages/server/src/shelf-routes.ts:132-145`: downloads use the same format guard
  and preserve the existing profile, hidden-file and missing-file checks.
- `packages/server/src/shelf-routes.test.ts:205-232` and
  `packages/server/src/lib/shelf.test.ts:5-9`: regression coverage includes an older
  book's newest text-only edition, a text-only book, pairing counts, downloads,
  hidden/foreign editions and translated/unknown-language labels.
- `packages/web/src/pages/PhonePage.tsx:259-278` and `docs/shelf.md:3-6,105-106`:
  owner-facing copy and the shelf contract match the new supported export format.
- `packages/desktop/src/main.cjs:397-401,477-481`: the standard native Edit menu
  restores macOS editing shortcuts. Context menus are registered once on the window
  before its first page loads and use native menu roles.
- `packages/desktop/src/editing.cjs:3-16`: editing actions use Chromium's edit flags;
  selected read-only text offers Copy, and empty page background opens no menu.
  No renderer privileges, clipboard bridge or external dependency is introduced.
- `packages/desktop/src/editing.test.ts:15-42`: four regression cases exercise empty
  input paste, action availability, copying reading text and the background case.
  Existing packaging includes `src/**/*`, so the new CommonJS helper ships.

## Reproduction and verification

The reported book's October 12 plain EPUB was excluded by the old allow-list, leaving
September 29 as its newest visible edition. iOS accepts format as a string and sorts
by the newest edition date. The shelf regression checks this scenario through HTTP.

The desktop application menu lacked Edit, and no context-menu handler existed.
A direct native UI check in an isolated Electron window confirmed Command-V delivers
a paste event and right-click shows the editing menu. The context-menu Paste click
was not completed because the user dismissed the menu; no further UI tests ran.
Earlier synthetic keyboard checks were inconclusive and are not counted as passes.

In this isolated release worktree, `pnpm lint` passed with existing warnings and
`pnpm typecheck` passed. `pnpm test` passed: 1,128 server, 166 web and 47 desktop tests,
1,341 total. Five private-fixture tests were skipped. The initial test attempts found
incompatible binaries in `/usr/local/bin`; the passing run used the configured
Apple Silicon conda environment and Homebrew tools first on PATH. No source change
was made to address that test environment issue.

No physical iOS-device or packaged-update verification was performed. The release
workflow must still pass CI, package/sign/notarize and publish before the installed
app can update. The existing EPUB needs no regeneration.
