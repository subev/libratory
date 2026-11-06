# Brand mark review, round 2 — 2026-11-07

Independent review of commit `5286475` on branch `chore/brand-new-mark` (range
`fa72f16..5286475`, one commit). Reviewer: Claude Fable 5.1, read-only; nothing was edited or
committed. Round 1 is `2026-11-06-brand-icon-review.md`; this round covers the delta since
that review (near-black tile as the default everywhere, the stale-icon guard) and re-checks
round 1's scope. The working tree was clean apart from the two untracked review reports.

## Scope reviewed

All 27 files in the commit:

- `packages/desktop/icons/app-icon/*.svg` — 64 px and up plus the maskable tile now carry the
  supplied dark vector's body on `#170906`, `rx=230` (maskable unrounded); 48 px and under
  carry the rich mark without the glow, tight crop, on the same ground
- `packages/desktop/icons/favicon/*.svg`, `packages/web/public/favicon.svg` — the small tile
- `packages/desktop/icons/mark/*.svg` — unchanged since round 1
- `scripts/desktop-build.sh` — `icon_stale` guard; `scripts/make-icon.sh` — comment only
- `packages/desktop/icons/README.md`, `packages/desktop/README.md`
- the commit message

## Verification performed

- Every SVG parses and renders with librsvg; a contact sheet at 16, 24, 32, 48, 64, 128 and
  1024 px plus the maskable tile was rendered and inspected.
- Art preservation, checked textually: after removing the ground rect and the two dropped
  `<g id>` attributes, the 1024 tile's body is character-for-character the supplied dark
  vector's body, and the 48 px tile's body is character-for-character the supplied rich
  mark's body (whitespace-normalised). Nothing was redrawn.
- Art preservation, checked as pixels: the full-bleed maskable tile rendered at 1024 px is
  identical (RMSE 0) to the supplied dark vector rendered the same way. Both differ from the
  supplied dark raster by RMSE 8.2%, which is therefore a renderer difference, not a change
  in the patch (see finding 1).
- Ids: seven per tile (`ember`, `pages`, `hot`, `soft`, `glow`, `markclip`, `flame`), no
  duplicates in any file; the supplied vector's repeated `<g id="ember|pages">` are gone.
  No comments, editor metadata, `<image>`, `<script>`, fonts or external references.
- Small tiles use `soft` and `hot` but not `glow` (`url(#glow)` count 0 at 48 and 16 px),
  as the README says.
- `icon_stale` exercised in place with the function copied from `scripts/desktop-build.sh:90`:
  a missing file is stale, a file newer than every tile is not, a file dated 2020 is stale.
  The script `cd`s to the repository root at line 16, so the relative `find` paths resolve.
  `find … -newer … -print -quit` is valid on both BSD and GNU find.
- Commit message scanned for words that do not belong in this repository: none.
- Round 1's consumers re-checked: `packages/web/index.html` (favicon),
  `scripts/desktop-build.sh` and `packages/desktop/package.json` (`build/icon.icns`,
  `build/icon.png`). No inline copy of the previous mark remains in shipped code.

## Round 1 findings, status

| # | Finding | Status |
|---|---|---|
| 1 | Local build kept a stale `.icns`/`icon.png` | Fixed by `icon_stale`, verified above; README line 55–57 documents it |
| 2 | 16 px not legible | Much improved: cream book on near-black reads as a book at 16 px, clearly at 24 px and up. No simplified drawing yet; now cosmetic only |
| 3 | Six mark files, two drawings | Unchanged, still Low; no consumers of `icons/mark/` |
| 4 | Old mark in design artifacts | Unchanged, informational |
| 5 | Generic ids in the rich mark | Still unique per file; tiles are consumed as files, not inlined |

## New findings

### 1. Low — the glow renders flatter in librsvg than in the supplied raster

The large tiles reproduce the supplied vector exactly, but librsvg draws its blurred glow
and hot spot dimmer than the supplied dark raster does (RMSE 8.2% at 1024 px, visibly a
softer halo on the contact sheet). `make-icon.sh` renders the `.icns` through librsvg, so
the Dock and Finder icon will look slightly flatter than surfaces drawn from the raster.
Not a defect in the patch. If parity matters, `make-icon.sh` could take a supplied PNG for
the 256 px and larger slots; otherwise accept.

### 2. Info — `packages/desktop/README.md:57` names only the tiles as the re-render trigger

The guard also re-renders when `scripts/make-icon.sh` is newer than the output. One
clause would make the README match the script. Trivial.

### 3. Info — small tiles still define the `glow` filter

`glow` is declared in `<defs>` of every tile but referenced only in the 64 px and larger
ones. Harmless; a few hundred bytes per small file.

## Verification gaps

- No desktop bundle was built; `.icns` generation was verified by reading the script, not by
  running it in this review.
- Rendering was checked with librsvg only. Browser SVG favicons were not viewed in a tab.
- The staleness guard was exercised on scratch files, not by running `desktop-build.sh`.
