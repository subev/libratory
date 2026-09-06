# Uninstalling Libratory — and where the 27 GB actually lives

A full install with every model downloaded reaches about **27 GB**, and almost none of it is inside
the app bundle. This page lists everything the app installs so you can remove exactly as much as
you mean to.

| What | Where | Size here |
| --- | --- | --- |
| The app | `/Applications/Libratory.app` | 451 MB |
| Python runtime, `uv`, staged scripts, config | `~/Library/Application Support/Libratory/` | 1.5 GB |
| **Your library** — books, chapters, notes, embeddings | Docker volume `libratory_pgdata17` | 5.2 GB |
| TTS and embedding models | `~/.cache/huggingface/hub/` (7 repos) | 9.7 GB |
| Marker's OCR and layout models | `~/Library/Caches/datalab/` | 5.1 GB |
| KugelAudio 4-bit quant | `~/.cache/libratory-models/` | 4.6 GB |
| Window state and preferences | `~/Library/Caches/dev.libratory.app/`, `~/Library/Preferences/dev.libratory.app.plist` | 84 KB |

Audio, uploads and exports live under `data/` inside the Application Support directory unless you pointed `dataDir` somewhere else — check `~/Library/Application Support/Libratory/config.json` before deleting anything, because that is where your finished audiobooks are.

### Remove the app, keep the library

Frees about 21 GB and leaves Postgres untouched, so a later reinstall finds every book where it was.

```bash
# stop the app, then its database container
pkill -f "Libratory.app/Contents/MacOS" 2>/dev/null
docker compose -f ~/Library/Application\ Support/Libratory/docker-compose.yml down

rm -rf /Applications/Libratory.app
rm -rf ~/Library/Application\ Support/Libratory/python \
       ~/Library/Application\ Support/Libratory/uv
rm -rf ~/.cache/libratory-models
rm -rf ~/Library/Caches/datalab
rm -rf ~/Library/Caches/dev.libratory.app
rm -f  ~/Library/Preferences/dev.libratory.app.plist

# models — only the seven repos this app downloaded, see the warning below
cd ~/.cache/huggingface/hub && rm -rf \
  models--hexgrad--Kokoro-82M \
  models--BAAI--bge-m3 \
  models--facebook--mms-tts-bul \
  models--raditotev--bg-tts-v5-mlx \
  models--kyutai--pocket-tts \
  models--kyutai--pocket-tts-without-voice-cloning \
  models--nineninesix--nemo-nano-codec-22khz-0.6kbps-12.5fps-MLX
```

> **`~/.cache/huggingface` is shared.** Every Python tool on your machine that touches Hugging Face uses it, so `rm -rf ~/.cache/huggingface` will also delete models that have nothing to do with this app. Remove the seven directories above and nothing else. `~/Library/Caches/datalab` belongs to marker and surya — keep it if you use those elsewhere.

### Remove everything, including the library

**This destroys your books, chapters, notes and embeddings permanently.** Export anything you want to keep first — assembled M4B files and EPUB exports already sit under `data/`, and copying that folder somewhere safe is enough to keep the audio even though the library metadata goes.

```bash
# everything from the section above, then:
docker volume rm libratory_pgdata17
rm -rf ~/Library/Application\ Support/Libratory
```

If you ever ran an older build, `docker volume ls | grep libratory` will show leftovers such as the pre-2026-08-08 `libratory_pgdata`; they are safe to remove once the current volume is gone.

### Keep a backup instead of deleting

A dump is a few seconds and about a tenth of the volume's size, so there is rarely a reason to delete the library outright rather than park it:

```bash
pg_dump "postgres://libratory:libratory@localhost:5433/libratory" -Fc -f ~/libratory-backup.dump
```

Restoring later needs a running container and `pg_restore -d … --no-owner ~/libratory-backup.dump`.
