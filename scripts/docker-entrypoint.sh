#!/bin/sh
# What `pnpm run setup` does for the native path, the entrypoint does for the container: cache
# the essential Kokoro voice into the /models volume before the server starts. Synthesis workers
# run HF_HUB_OFFLINE=1 and never download, so a fresh volume would otherwise serve the whole UI
# and then fail its first synthesis. models.py skips the fetch when the voice is already cached,
# which keeps later boots instant and offline-safe.
#
# Non-fatal on purpose: with no network and no cached voice the app still comes up — the library,
# uploads and raw extraction all work — and synthesis reports the missing voice when asked.
if ! /opt/venv/bin/python /app/scripts/models.py --essential; then
  echo "warning: could not cache the Kokoro voice (~350 MB); synthesis will fail until a restart with network access" >&2
fi
exec "$@"
