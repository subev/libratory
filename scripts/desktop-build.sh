#!/bin/bash
# Builds the desktop app, and optionally installs it over the copy in /Applications.
#
#   scripts/desktop-build.sh              build a .app and a .dmg
#   scripts/desktop-build.sh --install    …and replace /Applications/Libratory.app with it
#   scripts/desktop-build.sh --fast       skip the DMG; a .app is enough to test
#   scripts/desktop-build.sh --no-package  prepare resources only, for a signed build to package
#
# The install step exists because rebuilding proves nothing until the build is installed: it is
# easy to spend an afternoon reading the behaviour of the copy in /Applications while editing the
# one in release/.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
DESKTOP="$REPO/packages/desktop"
INSTALL=false; FAST=false; PACKAGE=true
for arg in "$@"; do
  case "$arg" in
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
if [ ! -d "$DESKTOP/resources/bin" ] || [ ! -d "$DESKTOP/resources/tessdata" ]; then
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
  # A pre-tesseract tarball unpacks cleanly and produces an app whose OCR fails with no useful
  # message, because TESSDATA_PREFIX would point at a directory that was never staged.
  [ -d "$DESKTOP/resources/tessdata" ] || {
    echo "    the pinned tools tarball carries no tessdata — rebuild with scripts/bundle-tools.py," >&2
    echo "    upload a new tools-N release and update url/sha256 in scripts/pins.json" >&2
    exit 1
  }
fi
[ -f "$DESKTOP/build/icon.icns" ] || { echo "==> rendering the icon"; bash scripts/make-icon.sh; }

echo "==> building the web bundle"
pnpm --filter @libratory/web build >/dev/null

echo "==> compiling the server"
mkdir -p "$DESKTOP/resources"
"$BUN" build --compile --target=bun-darwin-arm64 packages/server/src/main.ts \
  --outfile "$DESKTOP/resources/libratory-server" >/dev/null
rm -rf "$DESKTOP/resources/web" && cp -R packages/web/dist "$DESKTOP/resources/web"

$PACKAGE || { echo "    resources staged; packaging left to the caller"; exit 0; }

echo "==> packaging"
cd "$DESKTOP"
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
if $FAST; then npx electron-builder --mac --dir $ADHOC >/dev/null; else npx electron-builder --mac $ADHOC >/dev/null; fi

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
