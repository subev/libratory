#!/bin/sh
# Builds the BgTTS-38M-V2 environment: its own venv, because MioCodec needs torchaudio, which stops
# at 2.9.1, while the main env pins torch 2.13. ~1.5 GB once (torch, MioCodec, WavLM base+).
#
#   install_bgtts.sh <uv> <venv-dir> <scripts-dir>
#
# The one recipe behind `pnpm run setup --bgtts` and the voice picker's download button. Progress
# goes to stdout as JSON lines ({"type":"step",...}) for the server; everything else to stderr.
# Safe to run again: a venv still marked .installing is not counted as installed, so an interrupted
# run is offered again and resumes from uv's cache.
set -eu
# The desktop app hands its server a PATH of bundled tools, Homebrew and /usr/bin — no /bin, which is
# the only place macOS keeps mkdir and rm
PATH="${PATH:+$PATH:}/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

UV="$1"
VENV="$2"
SCRIPTS="$3"
MIOCODEC_REF="77473544375d57e96cbdfd5d7d257e8f280fa8e3"
PY="$VENV/bin/python"

step() { printf '{"type":"step","label":"%s"}\n' "$1"; }

mkdir -p "$VENV"
touch "$VENV/.installing"

step "Python environment"
"$UV" venv --python 3.12 --allow-existing "$VENV" >&2

TORCH=""
[ "$(uname -s)" = "Linux" ] && TORCH="--torch-backend=cpu"
step "PyTorch and audio libraries — about 1 GB"
# PyPI pinned for the same reason as the main env (#19): a configured private index answered 401
# shellcheck disable=SC2086
UV_INDEX="https://pypi.org/simple" UV_DEFAULT_INDEX="https://pypi.org/simple" \
  "$UV" --no-config pip install --python "$PY" --quiet $TORCH -r "$SCRIPTS/requirements-bgtts.txt" >&2

# An archive, not git+: a Mac without the developer tools has a git that only offers to install them.
# --no-deps because its pyproject points torch at the CUDA index (requirements-bgtts.in).
step "MioCodec"
UV_INDEX="https://pypi.org/simple" UV_DEFAULT_INDEX="https://pypi.org/simple" \
  "$UV" --no-config pip install --python "$PY" --quiet --no-deps \
  "miocodec @ https://github.com/Aratako/MioCodec/archive/$MIOCODEC_REF.tar.gz" >&2

step "Voice model and WavLM — about 500 MB"
HF_HUB_OFFLINE=0 "$PY" "$SCRIPTS/synthesize_bgtts.py" --cache-only >&2

rm -f "$VENV/.installing"
step "Done"
