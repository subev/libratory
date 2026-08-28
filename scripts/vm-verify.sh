#!/bin/bash
# Runs inside a fresh macOS VM to answer one question: does the DMG work on a machine that has
# never seen this project? Copy it in alongside the DMG and run it.
#
# It answers that question only up to Docker — see the note further down. A macOS guest cannot run
# Docker at all, so the database and everything after it needs a second physical Mac.
#
#   ./vm-verify.sh Libratory-0.0.1-arm64.dmg
#
# Everything it checks is something that has already been got wrong once on the host, where a
# stray Homebrew, a warm HuggingFace cache or an existing Postgres hid the problem.
set -uo pipefail

DMG="${1:-}"
[ -f "$DMG" ] || { echo "usage: $0 <path-to-dmg>"; exit 1; }

pass=0; fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }

echo "=== the machine, before anything ==="
echo "  macOS $(sw_vers -productVersion) on $(uname -m)"
# cirruslabs' base image ships Homebrew, so this is a note rather than a failure — what actually
# matters is that the three tools are absent, which is what makes the bundle the only source.
test -d /opt/homebrew/bin && echo "  NOTE  this image has Homebrew; the tool checks below are what matter"
check "no ffmpeg on PATH" '! command -v ffmpeg'
check "no pdftotext on PATH" '! command -v pdftotext'
check "no Python 3.12 on PATH" '! command -v python3.12'
check "no existing Libratory data" '! test -d "$HOME/Library/Application Support/Libratory"'
if ! command -v docker >/dev/null 2>&1 && ! test -S /var/run/docker.sock; then
  echo "  NOTE  Docker is not installed — the app should say so and stop, which is itself the test"
fi

echo
echo "=== install ==="
# An explicit mountpoint, because the volume name carries the version and a space —
# /Volumes/Libratory 0.0.1-arm64 — and parsing hdiutil's columns silently truncates it.
MOUNT=/tmp/p2a-dmg
rm -rf "$MOUNT" && mkdir -p "$MOUNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null || { echo "  could not mount $DMG"; exit 1; }
rm -rf /Applications/Libratory.app
cp -R "$MOUNT"/Libratory.app /Applications/ && echo "  copied to /Applications"
hdiutil detach "$MOUNT" -quiet
APP=$(ls -d /Applications/Libratory.app 2>/dev/null)
check "app is in /Applications" 'test -d "$APP"'

# Surviving the quarantine flag *is* the test for a released build, so it is deliberately left on.
# A locally built DMG is still ad-hoc and has to be stood down by hand, exactly as a person would.
if xcrun stapler validate "$APP" >/dev/null 2>&1; then
  check "Gatekeeper accepts it, quarantine and all" "spctl -a -t exec '$APP'"
else
  echo "  NOTE  ad-hoc build, not notarised — clearing quarantine, which is what right-click → Open does"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
fi

echo
echo "=== the bundled tools, with no Homebrew to fall back on ==="
BIN="$APP/Contents/Resources/bin"
for t in ffmpeg pdftotext pdfinfo; do
  check "$t runs from the bundle" "env PATH=/usr/bin:/bin '$BIN/$t' $([ "$t" = ffmpeg ] && echo -version || echo -v)"
done

echo
echo "=== first run ==="
# This is where a macOS VM stops being able to help, and it is worth being blunt about why.
# Libratory keeps its library in Postgres, Postgres runs in Docker, and Docker runs a Linux VM.
# Apple's Virtualization framework offers nested virtualization to *Linux* guests on M3 and later
# only — `tart run --nested` on a macOS guest answers "macOS virtual machines do not support
# nested virtualization" and refuses. So Docker Desktop and OrbStack both install fine in here and
# then sit at "Starting" forever, and everything downstream of the database is unreachable.
#
# What this VM genuinely proves is everything before that line, which is most of what breaks:
# that the DMG opens on a machine that never built it, that the bundled ffmpeg and poppler run
# with no Homebrew, and that the first-run screen says something useful when Docker is missing.
#
# The rest — Python, the models, the server, synthesis — needs a real second Mac.
open -a "$APP"
echo "  launched. In the VM you should now see:"
echo "    Audio and PDF tools   bundled"
echo "    Docker                Not installed  (with a panel offering Docker Desktop / OrbStack)"
echo
echo "  Installing Docker in here will move it to \"Installed, but not running\" and stop."
echo "  That is the ceiling of a macOS guest, not a bug in the app."

echo
echo "=== $pass passed, $fail failed ==="
echo "(Everything up to Docker. The full first run needs hardware, not a VM.)"
exit $((fail > 0))
