# Icon assets

Four size masters, each a separate drawing rather than a scale of the last.

| Master | Range | Drawing | Body stroke |
|---|---|---|---|
| 0 · rich | 128px and up | 3 leaf edges per side, 3 waves per ear, page curl | 2.9 |
| 1 · detailed | 40–127px | solid page block, 2 waves (1 at 48) | 3.2 / 3.5 / 4.1 |
| 2 · compact | 25–39px | 3 masses: flat book, head, body + arms | fills only |
| 3 · tiny | 24px and under | head merged into bust, fat stubs | fills only |

Strokes thicken as the size drops so optical weight stays constant.

## Brand pair
- tangerine `#e2601f` — ground
- ink `#2a1408` — figure and covers
- page `#fdf1e4` — pages and waves

## Folders
- `app-icon/` — SVG per size, correct master already chosen; `png/` mirrors it
- `app-icon/app-icon-maskable-512.*` — full-bleed, safe-zone inset, for Android adaptive icons
- `favicon/` — 16 / 32 / 48, tiny and compact masters
- `mark/` — the mark alone, no tile. `*-monochrome.svg` inherit `currentColor`
