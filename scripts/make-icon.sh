#!/bin/bash
# Turns the app mark into the .icns the bundle wants.
#
#   scripts/make-icon.sh [packages/desktop/icons/app-icon]
#
# Each size renders its own drawing rather than a scale of the last one: below about 40px the
# leaf edges and sound waves collapse into mush, so icons/app-icon/ carries four masters and
# names each file by the size it is for. The tile brings its own ground and rounded corners —
# macOS gives an app icon no background, and a transparent glyph in the dock reads as broken.
set -euo pipefail

SRC="${1:-packages/desktop/icons/app-icon}"
OUT="${2:-packages/desktop/build/icon.icns}"
[ -d "$SRC" ] || { echo "no icon directory at $SRC"; exit 1; }
command -v rsvg-convert >/dev/null || { echo "needs rsvg-convert (brew install librsvg)"; exit 1; }
command -v magick >/dev/null || { echo "needs ImageMagick 7 (brew install imagemagick)"; exit 1; }

SET=$(mktemp -d)/icon.iconset
mkdir -p "$SET" "$(dirname "$OUT")"

render() {  # canvas, outfile
  # 80%: macOS art sits inside the icon grid, not edge to edge
  local canvas=$1 inner=$(( $1 * 80 / 100 )) pad
  pad=$(( (canvas - inner) / 2 ))
  local tile="$SRC/app-icon-${canvas}.svg"
  [ -f "$tile" ] || { echo "no master for ${canvas}px at $tile"; exit 1; }
  rsvg-convert -w "$inner" -h "$inner" "$tile" -o "$SET/.tile.png"
  magick -size "${canvas}x${canvas}" xc:none \
    "$SET/.tile.png" -geometry "+${pad}+${pad}" -composite "$2"
  rm -f "$SET/.tile.png"
}

for size in 16 32 128 256 512; do
  render "$size" "$SET/icon_${size}x${size}.png"
  render "$((size * 2))" "$SET/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$SET" -o "$OUT"
rm -rf "$(dirname "$SET")"
echo "$OUT  ($(du -h "$OUT" | cut -f1))"
