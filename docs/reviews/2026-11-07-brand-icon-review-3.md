# Brand mark review, round 3 — 2026-11-07

Independent review of commit `3555f3b` on branch `chore/brand-new-mark` (range
`649cdeb..3555f3b`, one commit). Reviewer: Claude Fable 5.1, read-only; nothing edited or
committed. Rounds 1 and 2 are the two earlier files in this folder. This round covers the
change of approach: the vector-built tiles are gone and every icon is a plain downscale of
one supplied raster.

## Scope reviewed

All 25 files in the commit. Working tree clean at `3555f3b`.

- `packages/desktop/icons/app-icon/app-icon.png` — new, the supplied 1024 px raster
- `packages/desktop/icons/app-icon/*.svg` (13 files) and `packages/desktop/icons/favicon/*.svg`
  (3 files) — deleted
- `packages/web/public/favicon.png` — new, 64 px; `packages/web/public/favicon.svg` — deleted
- `packages/web/index.html:8` — favicon link now `image/png`, `sizes="64x64"`
- `scripts/make-icon.sh` — ImageMagick only: Lanczos downscale, round-rect mask at
  230/1024 of the inset tile, 80% inset, transparent padding, `PNG32` output
- `scripts/desktop-build.sh:95` — Linux `icon.png` is the raster at 512 px via ImageMagick
- `.github/workflows/release.yml:74` — `brew install imagemagick` only; librsvg dropped
- `packages/desktop/README.md:50,57`, `packages/desktop/icons/README.md` — rewritten
- `packages/desktop/icons/mark/*.svg` — untouched; the README now says nothing in the build
  uses them

## Verification performed

- **The source is the supplied file.** `app-icon.png` SHA-256 `1a26b573…c0c3` equals the
  supplied raster byte for byte; 1024×1024, opaque sRGB, corner `#170906`.
- **Every shipped raster is a plain downscale.** `packages/web/public/favicon.png` is RMSE 0
  against a Lanczos downscale of the source to 64 px.
- **The `.icns` was built from the committed script** (`scripts/make-icon.sh` with an output
  path in scratch; the working tree stayed clean) and unpacked with `iconutil`: all ten slots
  present (16–512, 1× and 2×). The 1024 px slot is RGBA, fully transparent in the padding and
  at the tile's corner, and its interior is RMSE 0 against a Lanczos downscale of the source
  to 819 px (the 80% inset), so the script neither redraws nor recolours. The 16 and 32 px
  slots and the 128 and 512 px slots were viewed.
- **Staleness guard still valid.** `scripts/desktop-build.sh:90` watches
  `packages/desktop/icons/app-icon` and `scripts/make-icon.sh`; the folder now holds the one
  PNG, so a changed raster or script still re-renders. The README names the PNG.
- **No dangling references.** Nothing outside `docs/reviews/` refers to the deleted SVG
  names, `rsvg`, or `favicon.svg`. `packages/web/index.html:8` is the only web consumer.
- **Workflow.** The release runner needs only ImageMagick and the system `iconutil`; the
  script checks for `magick` and exits with a hint if it is missing.
- Commit message scanned for words that do not belong in this repository: none. It matches
  the diff.

## Findings

No blockers. No code defects.

### 1. Info — 16 px is a soft blob, by construction

A plain downscale of a glowing raster to 16 px (and 12 px inside the macOS inset) reads as a
dark rounded square with a warm smudge; 32 px shows the book. This is what the chosen
approach produces and the icons README says so. Nothing to fix in this commit; a hand-tuned
small raster would be the only improvement and would break the "one source" rule.

### 2. Info — the web favicon is a single 64 px PNG

Browsers scale it to 16 or 32 px themselves. Fine for a PNG favicon; an `.ico` with 16/32
slots or a `sizes="any"` entry would only matter if someone wants crisper tab icons later.

### 3. Info — `icons/mark/*.svg` stay in the repository unused

They are the only vector copies of the mark and nothing builds from them. Harmless; the
README is explicit that they are not part of the icon pipeline.

## Round 1 and 2 findings, status

| Finding | Status |
|---|---|
| Stale local `.icns`/`icon.png` | Guard from round 2 still applies to the new source |
| 16 px legibility | Now a property of the raster approach; see finding 1 |
| Six mark files, two drawings | Unchanged, still unused |
| Old mark in design artifacts | Unchanged, informational |
| librsvg draws the glow flatter than the raster | Closed: librsvg is no longer used anywhere |

## Verification gaps

- The `.icns` was built here, but no desktop bundle was packaged and no Dock rendering was
  viewed.
- The web favicon was rendered at 16 and 32 px with ImageMagick, not viewed in a browser tab.
- The Linux `icon.png` path in `desktop-build.sh` was read, not executed.
