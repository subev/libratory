# Icon assets

The desktop icon is one supplied raster: `app-icon/app-icon.png`, 1024px, opaque, full bleed — the
glowing book under three sound waves on near-black. It is the artwork itself, not a drawing of
it; every icon size is a plain downscale of this file, never a redraw.

- `app-icon/app-icon.png` — the source. `scripts/make-icon.sh` rounds its corners, insets it to
  80% for the macOS icon grid and writes the `.icns`; Linux takes it at 512px edge to edge.
- `packages/web/public/favicon.png` — the same raster at 64px.
- `mark/` — the mark alone as vectors, no tile. `*-monochrome.svg` inherit `currentColor`;
  `rich-on-dark` carries the gradients; `rich-on-light` and `rich-on-tangerine` are the ink mark.
  Nothing in the build uses them; they are for places that need the outline without a tile.

Below about 32px the waves and page lines blur into the book; that is the raster at that size.
