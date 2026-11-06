#!/bin/bash
# Turns the icon raster into the .icns the bundle wants.
#
#   scripts/make-icon.sh [packages/desktop/icons/app-icon/app-icon.png]
#
# The source is the supplied 1024px raster, full bleed. Every size is a plain downscale of it,
# with the corners rounded and the tile inset to 80% — macOS gives an app icon no mask or
# background, and its art sits inside the icon grid, not edge to edge.
set -euo pipefail

SRC="${1:-packages/desktop/icons/app-icon/app-icon.png}"
OUT="${2:-packages/desktop/build/icon.icns}"
[ -f "$SRC" ] || { echo "no icon at $SRC"; exit 1; }
command -v magick >/dev/null || { echo "needs ImageMagick 7 (brew install imagemagick)"; exit 1; }

SET=$(mktemp -d)/icon.iconset
mkdir -p "$SET" "$(dirname "$OUT")"

render() {  # canvas, outfile
  local canvas=$1 inner=$(( $1 * 80 / 100 )) radius
  radius=$(( inner * 230 / 1024 ))
  magick "$SRC" -filter Lanczos -resize "${inner}x${inner}" -alpha set \
    \( -size "${inner}x${inner}" xc:none -fill white \
       -draw "roundrectangle 0,0 $(( inner - 1 )),$(( inner - 1 )) $radius,$radius" \) \
    -compose DstIn -composite \
    -compose Over -background none -gravity center -extent "${canvas}x${canvas}" "PNG32:$2"
}

for size in 16 32 128 256 512; do
  render "$size" "$SET/icon_${size}x${size}.png"
  render "$((size * 2))" "$SET/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$SET" -o "$OUT"
rm -rf "$(dirname "$SET")"
echo "$OUT  ($(du -h "$OUT" | cut -f1))"
