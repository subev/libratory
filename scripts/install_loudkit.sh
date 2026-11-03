#!/bin/sh
# Builds the loudkit environment: its own venv, because loudkit caps numpy below 2.4 while the other
# engine envs take 2.5.3. ~1.3 GB once (torch ~600 MB, the loudr-1 checkpoint 747 MB and its voices).
#
#   install_loudkit.sh <uv> <venv-dir> <scripts-dir>
#
# The voice picker's download button runs this. Progress goes to stdout as JSON lines
# ({"type":"step",...}) for the server; everything else to stderr. Safe to run again: a venv still
# marked .installing is not counted as installed, so an interrupted run is offered again and
# resumes from uv's and the Hugging Face cache.
set -eu
# The desktop app hands its server a PATH of bundled tools, Homebrew and /usr/bin — no /bin, which is
# the only place macOS keeps mkdir and rm
PATH="${PATH:+$PATH:}/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

UV="$1"
VENV="$2"
SCRIPTS="$3"
PY="$VENV/bin/python"

step() { printf '{"type":"step","label":"%s"}\n' "$1"; }

mkdir -p "$VENV"
touch "$VENV/.installing"

step "Python environment"
"$UV" venv --python 3.12 --allow-existing "$VENV" >&2

TORCH=""
[ "$(uname -s)" = "Linux" ] && TORCH="--torch-backend=cpu"
step "PyTorch and loudkit — about 600 MB"
# PyPI pinned for the same reason as the main env (#19): a configured private index answered 401
# shellcheck disable=SC2086
UV_INDEX="https://pypi.org/simple" UV_DEFAULT_INDEX="https://pypi.org/simple" \
  "$UV" --no-config pip install --python "$PY" --quiet $TORCH -r "$SCRIPTS/requirements-loudkit.txt" >&2

step "Voice model and voices — about 750 MB"
HF_HUB_OFFLINE=0 "$PY" "$SCRIPTS/synthesize_loudkit.py" --cache-only >&2

rm -f "$VENV/.installing"
step "Done"
