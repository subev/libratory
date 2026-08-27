# syntax=docker/dockerfile:1
# The headless-Linux deployment: one image holding the server, the built web UI and both Python
# environments, CPU-only. Models are not baked in — they land in the /models volume the same lazy
# way `pnpm run setup` leaves them out, so the image stays rebuildable without a 15 GB tax.

# ---- Web bundle -------------------------------------------------------------
FROM node:22-bookworm AS web-build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
COPY e2e/package.json e2e/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
# The web build type-checks against the server's router, imported straight from its source.
COPY packages/server packages/server
COPY packages/web packages/web
RUN pnpm --filter @libratory/web build

# ---- Runtime ----------------------------------------------------------------
FROM node:22-bookworm AS runtime
# ffmpeg carries the built-in aac encoder lib/ffmpeg.ts falls back to; espeak-ng is the G2P floor
# under Kokoro; poppler-utils is pdftotext; zip/unzip pack and unpack the read-along EPUBs.
# chromium renders the PDF/EPUB document exports — lib/vivliostyle.ts prefers a system browser,
# and the alternative is a 345 MB in-volume Chrome that would still be missing its shared libraries.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng poppler-utils zip unzip chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The same pinned, checksummed uv that scripts/setup.sh installs — read from the same pins.json,
# so a version bump stays one edit.
ARG TARGETARCH
RUN --mount=type=bind,source=scripts/pins.json,target=/tmp/pins.json <<'SH'
set -e
case "$TARGETARCH" in
  amd64) KEY=linux-x64 ;;
  arm64) KEY=linux-arm64 ;;
  *) echo "No pinned uv build for $TARGETARCH" >&2; exit 1 ;;
esac
UV_VERSION="$(node -p 'require("/tmp/pins.json").uv.version')"
UV_TARGET="$(node -p "require('/tmp/pins.json').uv['$KEY'].target")"
UV_SHA="$(node -p "require('/tmp/pins.json').uv['$KEY'].sha256")"
curl -fsSL --retry 3 -o /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz"
echo "$UV_SHA  /tmp/uv.tar.gz" | sha256sum -c - >/dev/null
tar -xzf /tmp/uv.tar.gz --strip-components=1 -C /usr/local/bin
rm /tmp/uv.tar.gz
SH

# Both Python environments live outside /app so a development bind-mount of the source cannot
# shadow them. env.ts is told where via CONDA_ENV_PATH/POCKET_ENV_PATH below.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PROJECT_ENVIRONMENT=/opt/venv
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv python install 3.12 && uv sync --frozen
COPY scripts/requirements-pocket.txt scripts/requirements-pocket.txt
# Pocket is CPU-only by design; --torch-backend keeps Linux from pulling the CUDA torch (setup.sh
# does the same for the native path).
RUN --mount=type=cache,target=/root/.cache/uv uv venv --python 3.12 /opt/venv-pocket \
    && uv pip install --python /opt/venv-pocket/bin/python --torch-backend=cpu -r scripts/requirements-pocket.txt

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
COPY e2e/package.json e2e/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY . .
COPY --from=web-build /app/packages/web/dist packages/web/dist

# /data is the library, /models holds every lazily-downloaded weight: the HF hub cache and the
# platformdirs (surya) cache both point inside it, so "backup the volumes" is the whole story.
# FONT_PATH moves marker's on-demand font out of site-packages, which is root-owned here and
# rightly so — the server runs as node and the image stays immutable. It must be the full path:
# marker precomputes FONT_PATH from FONT_DIR at import, so overriding the directory alone is inert.
# LIBRATORY_ENV_FILE lives in /data because the Settings panel writes API keys to it — written
# into the container's own filesystem they would vanish with the next `up --build`.
ENV NODE_ENV=production \
    CONDA_ENV_PATH=/opt/venv/bin \
    POCKET_ENV_PATH=/opt/venv-pocket/bin \
    DATA_DIR=/data \
    LIBRATORY_ENV_FILE=/data/.env \
    HOST=0.0.0.0 \
    PORT=3034 \
    HF_HOME=/models/hf \
    XDG_CACHE_HOME=/models/cache \
    FONT_PATH=/models/cache/marker-fonts/GoNotoCurrent-Regular.ttf
RUN mkdir -p /data /models && chown -R node:node /data /models
USER node
VOLUME ["/data", "/models"]
EXPOSE 3034

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3034)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The entrypoint caches the essential Kokoro voice into /models on first boot — the one model
# the lazy-download story cannot cover, because synthesis itself runs HF_HUB_OFFLINE=1.
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
# tsx from the server's own node_modules — the same way `pnpm dev` runs it, minus the watcher.
CMD ["packages/server/node_modules/.bin/tsx", "packages/server/src/main.ts"]
