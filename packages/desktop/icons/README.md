# Icon assets

The mark is an open book under three sound waves, one filled outline drawn on a 1024 grid.
Every file here is that same drawing; only the crop and the colours change.

| Use | Crop | Colours |
|---|---|---|
| tile, 64px and up | whole grid, mark at about 60% | the glowing mark on near-black |
| tile, 48px and under | tighter, mark at about 90% | the rich mark on near-black, no glow |
| mark | the mark alone, no tile | see below |

Below about 24px the sound waves and page lines blur into the book. There is no simplified
small drawing yet; dropping the glow and cropping tighter is what keeps the book's outline
legible in a browser tab.

## Colours
- near-black `#170906` — the tile's ground
- ember gradient (`#FFC27A` → `#E8690F`) on the waves and a warm page gradient (`#FFC48F` →
  `#FFF0E0`) on the book — the rich mark
- the large tiles add a soft orange glow behind the mark and a hot spot at the spine
- tangerine `#E2601F` and ink `#1E1B14` — the flat pair, still used by `mark/rich-on-light` and
  `mark/rich-on-tangerine` (ink mark)

## Folders
- `app-icon/` — SVG per size; the tile brings its own rounded corners
- `app-icon/app-icon-maskable-512.svg` — full-bleed, the mark inside the safe zone, for Android
  adaptive icons
- `favicon/` — 16 / 32 / 48
- `mark/` — the mark alone, no tile. `*-monochrome.svg` inherit `currentColor`; `rich-on-dark`
  carries the gradients; `rich-on-light` and `rich-on-tangerine` are the ink mark
