# Brand mark review — 2026-11-06

Independent review of the uncommitted brand-mark change on branch `chore/brand-new-mark`
(base `fa72f16`). Reviewer: Claude Fable 5.1, read-only; no edits were made, nothing was
committed. Commit messages for this change are not written yet and are not covered.

## Scope reviewed

Every dirty file in the checkout, verified to match the handed-over patch exactly
(`git apply --check -R`):

- `packages/desktop/icons/app-icon/*.svg` — 12 sized tiles plus `app-icon-maskable-512.svg`
- `packages/desktop/icons/favicon/favicon-{16,32,48}.svg`
- `packages/desktop/icons/mark/*.svg` — six mark files
- `packages/web/public/favicon.svg`
- `packages/desktop/icons/README.md`, `scripts/make-icon.sh` (comment only)

## Verification performed

- All 23 SVGs parse and render with `rsvg-convert`; a contact sheet was rendered at 16, 24,
  32, 48, 64, 128 and 1024 px, the maskable tile at 512, and the rich/ink marks on dark,
  cream and tangerine grounds, and inspected visually. Tiles and marks are the same
  drawing as the committed master; only crop and colour differ, as the README says.
- Every `id` is unique within its file (ids exist only in `mark-rich-on-dark.svg`). No
  comments, editor metadata, `<image>`, `<script>`, fonts or external references in any SVG.
- Tile contrast: ink `#1E1B14` on tangerine `#E2601F` computes to 4.85:1 (WCAG AA for
  large/graphic use).
- `scripts/make-icon.sh` is unchanged apart from its comment; it consumes the same file
  names, so `.icns` generation needs no other change. `scripts/check-icons.mjs` scans
  `packages/web/src` for hand-rolled icons and says nothing about these files; it was not
  relied on as evidence.
- Consumers searched across the repo: `packages/web/index.html` (favicon),
  `scripts/desktop-build.sh` and `packages/desktop/package.json` (`build/icon.icns`,
  `build/icon.png`). The web UI draws no brand mark of its own. No remaining inline copy
  of the previous mark in shipped code.
- Added lines of the patch were scanned for words that do not belong in this repository.
  None found.

## Findings

### 1. Medium — a local desktop build keeps the old icon until two generated files are deleted

`scripts/desktop-build.sh:91` and `:93` render `packages/desktop/build/icon.png` (Linux)
and `packages/desktop/build/icon.icns` (macOS) only when the file is absent. Both are
gitignored (`packages/desktop/.gitignore:3`). A checkout that has built before keeps the
previous artwork: on this machine the main checkout holds an `icon.icns` from 2026-08-28
and an `icon.png` from 2026-10-06. The release workflow (`.github/workflows/release.yml:80`)
runs on a fresh runner with only a pnpm cache, so tagged releases regenerate correctly;
local packaging does not.

Repro: build the desktop app from a checkout that already has `packages/desktop/build/`,
open the bundle, the Dock icon is the old mark.

Suggested fix (either): delete both files when this lands and extend the note at
`packages/desktop/README.md:55` to name `icon.png` as well; or make the two guards also
re-render when any `packages/desktop/icons/app-icon/*.svg` is newer than the output
(`find … -newer`). The hand-over report mentioned only the `.icns`.

### 2. Low (cosmetic, acknowledged in the README) — 16 px is not legible

At 16 px (`app-icon-16.svg`, `favicon-16.svg`, and `packages/web/public/favicon.svg` on a
1× display) the tile reads as an orange square with a dark smudge; the waves vanish and the
book is a blob. 24 px is borderline, 32 px and up read well. The previous set carried a
purpose-built tiny master for this range; the tighter crop is an improvement over a plain
scale but does not replace it. `make-icon.sh` additionally insets macOS art to 80%, so the
16 px `.icns` slot renders the 16 px tile at 12 px. The README states the limitation
honestly. A simplified small drawing (waves dropped, book strokes thickened) would restore
the old guarantee; not a blocker.

### 3. Low — six mark files, two drawings

`mark-compact-monochrome.svg`, `mark-detailed-monochrome.svg` and
`mark-tiny-monochrome.svg` are byte-identical, as are `mark-rich-on-light.svg` and
`mark-rich-on-tangerine.svg`. Nothing in the repo consumes `icons/mark/`. Keeping the names
is harmless and the README explains it; the set could be trimmed to three files later.

### 4. Info — the old mark survives only in design artifacts

`tasks/solar-dusk-restyle.md`, `tasks/assistant-panel/Assistant Panel.dc.html` and
`docs/design/bilingual-reader/Bilingual Reader.dc.html` still embed the previous figure.
They are design boards and notes, not shipped assets. Matches in
`packages/web/src/styles.css` are the palette's ink and cream tokens, not the mark.

### 5. Info — generic ids in the rich mark

`mark-rich-on-dark.svg` defines `ember`, `pages`, `hot`, `soft`, `glow`, `flame`,
`markclip`, `ember-shape`, `pages-shape`. Unique within the file and safe through `<img>`
or as a standalone icon. If it is ever inlined into a page beside other SVGs, prefix them.

## Verification gaps

- No desktop bundle was built; `.icns` generation was verified by reading the script and
  the file names it expects, not by running it.
- Rendering was checked with librsvg only; browser and macOS renderers were not exercised.
- The web favicon was not viewed in a browser tab, only rendered at 16 and 32 px.
- Commit messages are not yet written and were not reviewed.
