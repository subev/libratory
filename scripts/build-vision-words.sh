#!/bin/bash
# Compiles scripts/vision-words.swift into a standalone binary: scripts/build-vision-words.sh <out>
# Needs the Swift toolchain (Xcode or its Command Line Tools); the server calls this itself in
# development, and the desktop build calls it to place the binary beside the bundled tools.
set -euo pipefail
OUT="${1:?output path}"
SRC="$(cd "$(dirname "$0")" && pwd)/vision-words.swift"
mkdir -p "$(dirname "$OUT")"
swiftc -O -framework Vision -framework AppKit "$SRC" -o "$OUT"
