#!/bin/bash
# Builds the desktop app, and optionally installs it over the copy in /Applications.
#
#   scripts/desktop-build.sh              build a .app and a .dmg
#   scripts/desktop-build.sh --install    …and replace /Applications/Libratory.app with it
#   scripts/desktop-build.sh --fast       skip the DMG; a .app is enough to test
#   scripts/desktop-build.sh --no-package  prepare resources only, for a signed build to package
#   scripts/desktop-build.sh --linux      an AppImage instead (LINUX_ARCH=x64|arm64, default x64);
#                                         ffmpeg, poppler and tesseract come from the distribution
#
# The install step exists because rebuilding proves nothing until the build is installed: it is
# easy to spend an afternoon reading the behaviour of the copy in /Applications while editing the
# one in release/.
set -euo pipefail

cd "$(dirname "$0")/.."

# Output kept for the failure, not the success. These three are noisy when they work and the only
# line worth reading is the one they print when they do not — and `>/dev/null` threw exactly that
# away: a DMG whose volume would not unmount exited 1 with an empty log and nothing to go on.
quietly() {
  local log status
  log="$(mktemp -t libratory-build)"
  if "$@" >"$log" 2>&1; then status=0; else status=$?; cat "$log" >&2; fi
  rm -f "$log"
  return $status
}
REPO="$PWD"
DESKTOP="$REPO/packages/desktop"
INSTALL=false; FAST=false; PACKAGE=true; LINUX=false
LINUX_ARCH="${LINUX_ARCH:-x64}"
for arg in "$@"; do
  case "$arg" in
    --linux) LINUX=true ;;
    --install) INSTALL=true ;;
    --fast) FAST=true ;;
    --no-package) PACKAGE=false ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

# Bun compiles the server to one binary. Fetched here rather than made a prerequisite, the same way
# the app fetches uv — and pinned, because `bun build --compile` is what decides what the DMG
# contains and an unpinned installer changes that silently.
BUN_VERSION="1.3.9"
BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  BUN="$REPO/.bun/bin/bun"
  if [ ! -x "$BUN" ]; then
    echo "==> fetching bun $BUN_VERSION"
    curl -fsSL https://bun.sh/install | env BUN_INSTALL="$REPO/.bun" bash -s "bun-v$BUN_VERSION" >/dev/null
  fi
fi



# The CLI tools that ship inside the app are downloaded, not built: Homebrew has no versioned
# formula for them and upgrades them under you, so a machine that installs "ffmpeg" gets whatever is
# current — which is how CI came to hold 8.1.2 against the 7.1.1 this was tested with. Pinned and
# checksummed here for the same reason uv and bun are. scripts/bundle-tools.py rebuilds it.
if $LINUX; then
  # No tools tarball and no Vision binary: a Linux first run checks the distribution's packages
  rm -rf "$DESKTOP/resources/bin" "$DESKTOP/resources/tessdata"
elif [ ! -d "$DESKTOP/resources/bin" ] || [ ! -d "$DESKTOP/resources/tessdata" ]; then
  echo "==> fetching the bundled CLI tools"
  read -r TOOLS_URL TOOLS_SHA <<<"$(node -e '
    const p = require("./scripts/pins.json").bundledTools;
    console.log(p.url, p.sha256);
  ')"
  mkdir -p "$DESKTOP/resources"
  curl -fsSL --retry 3 -o /tmp/p2a-tools.tar.gz "$TOOLS_URL"
  echo "$TOOLS_SHA  /tmp/p2a-tools.tar.gz" | shasum -a 256 -c - >/dev/null
  tar -xzf /tmp/p2a-tools.tar.gz -C "$DESKTOP/resources"
  rm -f /tmp/p2a-tools.tar.gz
  [ -d "$DESKTOP/resources/tessdata" ] || {
    echo "    the pinned tools tarball carries no tessdata — rebuild with scripts/bundle-tools.py," >&2
    echo "    upload a new tools-N release and update url/sha256 in scripts/pins.json" >&2
    exit 1
  }
fi
# Apple Vision word boxes for the AI OCR engine (scripts/vision-words.swift): compiled here rather
# than shipped in the tools tarball, since the Swift toolchain is on every build Mac and the source
# is the pin. Without it the engine falls back to Tesseract's boxes.
if ! $LINUX && { [ ! -x "$DESKTOP/resources/bin/vision-words" ] || [ scripts/vision-words.swift -nt "$DESKTOP/resources/bin/vision-words" ]; }; then
  echo "==> compiling vision-words"
  bash scripts/build-vision-words.sh "$DESKTOP/resources/bin/vision-words" \
    || echo "    no Swift toolchain — the AI OCR engine will place words with Tesseract's boxes instead" >&2
fi
if $LINUX; then
  # Linux draws icons edge to edge; the macOS inset is make-icon.sh's business
  [ -f "$DESKTOP/build/icon.png" ] || { echo "==> rendering the icon"; rsvg-convert -w 512 -h 512 packages/desktop/icons/app-icon/app-icon-512.svg -o "$DESKTOP/build/icon.png"; }
else
  [ -f "$DESKTOP/build/icon.icns" ] || { echo "==> rendering the icon"; bash scripts/make-icon.sh; }
fi

echo "==> building the web bundle"
quietly pnpm --filter @libratory/web build

echo "==> compiling the server"
mkdir -p "$DESKTOP/resources"
if $LINUX; then BUN_TARGET="bun-linux-$LINUX_ARCH"; else BUN_TARGET="bun-darwin-arm64"; fi
quietly "$BUN" build --compile --target="$BUN_TARGET" packages/server/src/main.ts \
  --outfile "$DESKTOP/resources/libratory-server"
rm -rf "$DESKTOP/resources/web" && cp -R packages/web/dist "$DESKTOP/resources/web"

$PACKAGE || { echo "    resources staged; packaging left to the caller"; exit 0; }

echo "==> packaging"
cd "$DESKTOP"
if $LINUX; then
  if [ "$(uname -s)" = Darwin ]; then
    # The AppImage step runs a Linux-only tool (its macOS build is x86_64, which needs Rosetta), so on
    # a Mac the app is laid out here and wrapped inside a Linux container of the same architecture
    quietly npx electron-builder --linux dir "--$LINUX_ARCH"
    PLATFORM="linux/$([ "$LINUX_ARCH" = x64 ] && echo amd64 || echo arm64)"
    quietly docker run --rm --platform "$PLATFORM" -v "$REPO":/repo -w /repo/packages/desktop \
      -e ELECTRON_BUILDER_CACHE=/repo/packages/desktop/release/.eb-cache node:22-bookworm \
      npx --no-install electron-builder --linux AppImage "--$LINUX_ARCH" --prepackaged "release/linux-$([ "$LINUX_ARCH" = x64 ] && echo unpacked || echo arm64-unpacked)"
  else
    quietly npx electron-builder --linux AppImage "--$LINUX_ARCH"
  fi
  ls -lh "$DESKTOP"/release/*.AppImage | awk '{print "    " $9 "  " $5}'
  exit 0
fi
# No Developer ID yet, but "unsigned" and "ad-hoc signed" are very different to macOS: an app with
# only the linker's partial signature is reported as *damaged*, with Move to Bin as the only button
# and no way back. A complete ad-hoc signature (mac.identity "-") downgrades that to the ordinary
# unidentified-developer refusal, which Privacy & Security can override. Auto-discovery stays off
# so a stray keychain identity cannot produce something that only runs on the machine that built it.
export CSC_IDENTITY_AUTO_DISCOVERY=false
# Ad-hoc here, always: a local build has no certificate and must not pick one up. The real
# identity is passed only by the release workflow, and only when the secret exists — the flag lives
# there rather than in package.json so that arriving certificate is not silently ignored.
ADHOC="-c.mac.identity=-"
if $FAST; then quietly npx electron-builder --mac --dir $ADHOC; else quietly npx electron-builder --mac $ADHOC; fi

APP="$DESKTOP/release/mac-arm64/Libratory.app"
echo "    $APP"
$FAST || ls -lh "$DESKTOP"/release/*.dmg | awk '{print "    " $9 "  " $5}'

if $INSTALL; then
  echo "==> installing over /Applications"
  pkill -f "Libratory.app/Contents/MacOS" 2>/dev/null || true
  pkill -f "Resources/libratory-server" 2>/dev/null || true
  rm -rf /Applications/Libratory.app
  cp -R "$APP" /Applications/
  # An unsigned app is quarantined the moment it comes off a DMG or a download. This is what
  # right-click → Open does, and it is the one step a real user cannot be asked to script.
  xattr -dr com.apple.quarantine /Applications/Libratory.app 2>/dev/null || true
  echo "    /Applications/Libratory.app  (quarantine cleared)"
fi
