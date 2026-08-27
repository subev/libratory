#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$REPO_DIR/.venv"
POCKET_VENV_DIR="$REPO_DIR/.venv-pocket"
WITH_KUGEL=false
[ "${1:-}" = "--kugel" ] && WITH_KUGEL=true

echo "=== Libratory setup ==="

# Apple Silicon gets everything; Linux gets everything except the two MLX narrators, which are
# Metal and say so in the UI. Anything else has no local TTS story, so refusing beats half-installing.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=mac ;;
  Linux-*) PLATFORM=linux ;;
  *)
    echo "This setup targets Apple Silicon Macs and Linux — $(uname -s)/$(uname -m) can run neither the MLX nor the CPU engines."
    exit 1
    ;;
esac

echo ""
echo "Checking prerequisites..."
# The hint is the part someone copy-pastes, so it names the package manager this machine has.
if [ "$PLATFORM" = "mac" ]; then
  INSTALL="brew install"
elif command -v apt-get >/dev/null 2>&1; then
  INSTALL="sudo apt install"
elif command -v dnf >/dev/null 2>&1; then
  INSTALL="sudo dnf install"
else
  INSTALL="install via your package manager:"
fi
POPPLER_PKG="poppler"; [ "$PLATFORM" = "linux" ] && POPPLER_PKG="poppler-utils"
NODE_HINT="brew install node"; [ "$PLATFORM" = "linux" ] && NODE_HINT="from nodejs.org or your distribution"
PYTHON_HINT="brew install python@3.12"
if [ "$PLATFORM" = "linux" ]; then
  # Debian splits venv creation out of the interpreter package, and setup creates one for Pocket TTS.
  PYTHON_HINT="$INSTALL python3.12"; command -v apt-get >/dev/null 2>&1 && PYTHON_HINT="$INSTALL python3.12 python3.12-venv"
fi
missing=()
command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg ($INSTALL ffmpeg)")
command -v espeak-ng >/dev/null 2>&1 || missing+=("espeak-ng ($INSTALL espeak-ng)")
command -v pdftotext >/dev/null 2>&1 || missing+=("pdftotext ($INSTALL $POPPLER_PKG)")
command -v pnpm >/dev/null 2>&1 || missing+=("pnpm (npm install -g pnpm)")
if [ "$PLATFORM" = "linux" ]; then
  # Read-along EPUBs are packed with the system zip; every Mac ships it, minimal servers do not.
  command -v zip >/dev/null 2>&1 || missing+=("zip ($INSTALL zip)")
  command -v unzip >/dev/null 2>&1 || missing+=("unzip ($INSTALL unzip)")
fi
if command -v node >/dev/null 2>&1; then
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || missing+=("Node.js >= 20 ($NODE_HINT)")
else
  missing+=("Node.js >= 20 ($NODE_HINT)")
fi

PYTHON=""
# Ubuntu 24.04's python3 IS 3.12 — asking for python3.12 by name would send someone off to
# install exactly what they already have.
for cand in python3.12 /opt/homebrew/opt/python@3.12/bin/python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null; then
    PYTHON="$(command -v "$cand")"; break
  fi
done
[ -n "$PYTHON" ] || missing+=("Python 3.12 ($PYTHON_HINT)")

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites:"
  for m in "${missing[@]}"; do echo "  - $m"; done
  exit 1
fi
echo "  ffmpeg: $(which ffmpeg)"
echo "  espeak-ng: $(which espeak-ng)"
echo "  pdftotext: $(which pdftotext)"
echo "  python: $PYTHON ($("$PYTHON" --version))"
echo "  node: $(node --version), pnpm: $(pnpm --version)"
if command -v docker >/dev/null 2>&1; then
  echo "  docker: $(docker --version)"
else
  if [ "$PLATFORM" = "mac" ]; then
    echo "  ! docker not found — install OrbStack or Docker Desktop before the database step"
  else
    echo "  ! docker not found — install Docker Engine (docs.docker.com/engine/install) before the database step"
  fi
fi

echo ""
# Pinned and checksummed, for the same reasons packages/desktop/src/setup.cjs spells out: piping
# an installer into a shell runs unverified code and reports its own failures as success, because
# `set -e` sees sh's exit status and not curl's.
case "$PLATFORM-$(uname -m)" in
  mac-arm64) UV_ARCH="arm64" ;;
  linux-x86_64) UV_ARCH="linux-x64" ;;
  linux-aarch64) UV_ARCH="linux-arm64" ;;
  *) echo "No pinned uv build for $PLATFORM/$(uname -m)"; exit 1 ;;
esac
# scripts/pins.json is the one copy; node is already a hard requirement above
read -r UV_VERSION UV_TARGET UV_SHA <<<"$(node -e '
  const p = require("./scripts/pins.json");
  console.log(p.uv.version, p.uv[process.argv[1]].target, p.uv[process.argv[1]].sha256);
' "$UV_ARCH")"
UV="$REPO_DIR/.uv/uv"
if [ ! -x "$UV" ]; then
  echo "Installing uv $UV_VERSION..."
  mkdir -p "$REPO_DIR/.uv"
  curl -fsSL --retry 3 -o "$REPO_DIR/.uv/uv.tar.gz" \
    "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz"
  # shasum is macOS's spelling, sha256sum is coreutils' — whichever this machine has is fine.
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$UV_SHA  $REPO_DIR/.uv/uv.tar.gz" | sha256sum -c - >/dev/null
  else
    echo "$UV_SHA  $REPO_DIR/.uv/uv.tar.gz" | shasum -a 256 -c - >/dev/null
  fi
  tar -xzf "$REPO_DIR/.uv/uv.tar.gz" --strip-components=1 -C "$REPO_DIR/.uv"
  rm -f "$REPO_DIR/.uv/uv.tar.gz"
fi
echo "  uv: $("$UV" --version)"

echo ""
echo "Creating Python environment at .venv from uv.lock..."
# uv.lock pins the whole graph, including three conflicts that pip only survived because the
# packages were installed with --no-deps: mlx-audio wants transformers 5.x (breaks marker) and
# huggingface_hub 1.x, and nanocodec-mlx wants mlx 0.29.2. pyproject states those as overrides.
(cd "$REPO_DIR" && "$UV" sync --frozen)
PY="$VENV_DIR/bin/python"

echo ""
echo "Verifying Python runtimes..."
"$PY" -c "import marker; print(f'  marker: {marker.__version__}')" 2>/dev/null || echo "  marker: installed (version check N/A)"
"$PY" -c "from kokoro import KPipeline; print('  kokoro: OK')"
"$PY" -c "from transformers import AutoTokenizer, VitsModel; print('  mms runtime: OK')"
[ "$PLATFORM" != "mac" ] || "$PY" -c "import mlx.core; print('  mlx: OK')"

# What a first run must have lives in scripts/models.py, which the desktop app calls too — spelling
# it out again here is how the two paths drift.
echo ""
echo "Caching the models a first run needs (~350 MB)..."
"$PY" "$REPO_DIR/scripts/models.py" --essential

echo ""
# Everything else — Marker 5.1 GB, BGE-M3 4.3 GB, the Bulgarian narrators 1.2 GB — is fetched by
# scripts/models.py the first time someone asks for the feature it powers. Downloading all of it
# here meant ~15 GB and an hour before the app could open a single page.
if [ "${WITH_ALL_MODELS:-}" = "1" ]; then
  echo "WITH_ALL_MODELS=1 — fetching every optional bundle up front..."
  "$PY" "$REPO_DIR/scripts/models.py" --download-all
else
  echo "Optional models (Marker/OCR, library search, Bulgarian narrators) download on first use."
  "$PY" "$REPO_DIR/scripts/models.py" --status >/dev/null && echo "  model registry: OK"
fi

echo ""
# Separate venv: pocket-tts requires numpy>=2, the main env is pinned to numpy 1.26.4.
echo "Creating Pocket TTS environment at .venv-pocket..."
[ -x "$POCKET_VENV_DIR/bin/python" ] || "$PYTHON" -m venv "$POCKET_VENV_DIR"
POCKET_PY="$POCKET_VENV_DIR/bin/python"
# Pocket is CPU-only by design, but on Linux PyPI answers a plain "torch" with the CUDA build —
# half a gigabyte of wheel and a train of nvidia-* packages the engine never loads.
POCKET_TORCH=()
[ "$PLATFORM" = "linux" ] && POCKET_TORCH=(--torch-backend=cpu)
"$UV" pip install --python "$POCKET_PY" --quiet "${POCKET_TORCH[@]}" -r "$REPO_DIR/scripts/requirements-pocket.txt"

# .env is written later in this script, so read the token straight out of it when present.
if [ -z "${HF_TOKEN:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  HF_TOKEN="$(grep -E '^HF_TOKEN=.+' "$REPO_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r')"
  export HF_TOKEN
fi

echo "Caching Pocket TTS model and catalog voices (~500 MB)..."
if [ -n "${HF_TOKEN:-}" ]; then
  echo "  HF_TOKEN set — will also fetch the gated voice-cloning weights"
else
  echo "  no HF_TOKEN — catalog voices only (cloning needs an account; see README)"
fi
"$POCKET_PY" "$REPO_DIR/scripts/synthesize_pocket_tts.py" --cache-only

echo ""
KUGEL_DIR="$HOME/.cache/libratory-models/kugelaudio-0-open-4bit"
if [ "$PLATFORM" != "mac" ]; then
  echo "KugelAudio narrator: Apple Silicon only (MLX) — skipped"
elif [ -d "$KUGEL_DIR" ]; then
  echo "KugelAudio narrator: already present"
elif ! $WITH_KUGEL && [ -t 0 ]; then
  read -r -p "Download the KugelAudio narrator (24 EU languages)? Downloads ~17 GB once, quantizes to ~5 GB, then deletes the download. [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] && WITH_KUGEL=true
fi
if [ ! -d "$KUGEL_DIR" ] && $WITH_KUGEL; then
  echo "Preparing KugelAudio narrator..."
  "$PY" -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen2.5-7B', allow_patterns=['tokenizer*', 'vocab*', 'merges*', 'config.json'])"
  "$PY" -m mlx_audio.convert --hf-path kugelaudio/kugelaudio-0-open --mlx-path "$KUGEL_DIR" -q --q-bits 4 --model-domain tts \
    && "$PY" -c "from huggingface_hub import scan_cache_dir; c = scan_cache_dir(); [c.delete_revisions(*[r.commit_hash for r in repo.revisions]).execute() for repo in c.repos if repo.repo_id == 'kugelaudio/kugelaudio-0-open']" \
    && echo "  kugelaudio 4-bit: OK" \
    || echo "  kugelaudio: conversion failed — rerun 'pnpm run setup --kugel' or synthesize with another voice"
elif [ ! -d "$KUGEL_DIR" ]; then
  echo "KugelAudio narrator: skipped (run 'pnpm run setup --kugel' to add it later)"
fi

echo ""
if [ ! -f "$REPO_DIR/.env" ]; then
  echo "Creating .env..."
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  printf 'CONDA_ENV_PATH=%s/bin\n' "$VENV_DIR" >> "$REPO_DIR/.env"
else
  echo ".env already exists — leaving it untouched"
fi

echo ""
echo "Installing Node.js dependencies..."
cd "$REPO_DIR"
pnpm install

echo ""
if docker info >/dev/null 2>&1; then
  echo "Starting Postgres and running migrations..."
  pnpm db:up
  pnpm db:migrate
else
  echo "Docker is not available — install/start OrbStack or Docker Desktop, then run:"
  echo "  pnpm db:up && pnpm db:migrate"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start the app with: pnpm dev"
echo "  web: http://localhost:3033   api: http://localhost:3034"
echo ""
echo "AI features (translations, rewrites, digests, Ask AI, library chat, LLM chapter detection):"
echo "  Offline (recommended): install LM Studio (lmstudio.ai) or Ollama (ollama.com) and download a"
echo "  chat model — a current ~27-30B reasoning model (e.g. Qwen3.8 27B) is a strong offline pick on"
echo "  32GB+ machines; use an 8B-class model on smaller machines. Running servers and their models are"
echo "  auto-detected — check the gear icon in the app."
echo "  Cloud: add an API key (DeepSeek/OpenAI/Anthropic/Gemini) via the same gear icon or .env."
