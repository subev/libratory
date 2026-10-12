# Shelf menu release review — 2026-10-12

## Scope and outcome

Reviewed the complete outgoing change from main
`53556009efa6d6f4ac8b6c63e8e8dc38ecd83f40`: the shelf display changes in
`packages/web/src/pages/PhonePage.tsx` and this report. No blocking findings.
The release worktree excludes all unrelated pending changes and the chapter
crafting design brief. No API, export, visibility setting, or data changes.

## Findings and fix

- `PhonePage.tsx:267`: the table's overflow clipping hid the absolutely positioned
  menu below the last export row. Removing clipping allows the existing menu to
  extend outside the rounded container; the container still paints its rounded
  background and border.
- `PhonePage.tsx:284`: row-wide opacity faded the menu and created a stacking
  context. Removing it keeps actions legible and lets their existing z-index
  work across rows.
- `PhonePage.tsx:300`: visibility was appended to truncated metadata. A separate
  wrapping status now exposes the complete “Hidden from phones” message.
- `components/Menu.tsx:73`: reviewed the existing absolute positioning and
  z-index, dismissal, and item callbacks. The shared menu is unchanged.

## Reproduction and verification

Before the fix, open Phone with a hidden EPUB export, then open the last row's
ellipsis menu. The menu extends below the row but is clipped at the table border;
the visibility message can truncate to “hidden fro…”.

After the fix, a headless Chromium check against the local frontend used a mocked
hidden EPUB, leaving real shelf visibility untouched. Both “Show on phones” and
“Open the book” passed Playwright trial clicks and DOM hit testing, including the
part extending below the table. Escape dismissed the menu. The screenshot was
visually inspected; the menu and the full wrapping status were visible.

Required checks in the isolated release worktree:

- `pnpm lint`: passed, existing warnings only.
- `pnpm typecheck`: passed.
- `pnpm test`: passed, 1,341 tests (1,128 server, 166 web, 47 desktop),
  with five private-fixture tests skipped.
- `git diff --check`: passed.

The first test run hit an existing first-use tessdata staging collision
(`EEXIST` copying `configs`). The complete rerun passed after staging completed;
no test or production code was changed to suppress it.

## Verification limits

The browser check did not execute visibility mutations or change any book.
No native desktop interaction or full local E2E suite was run for this CSS-only
fix; the deployed bundle and CI remain the release verification gates. Existing
narrow-screen shelf layout and counts are outside this change.
