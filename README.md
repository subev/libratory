<h1 align="center">Libratory</h1>

<p align="center">
  <b>Your free book and audiobook laboratory.</b><br>
  Turn the PDFs you already own into chapter-marked audiobooks — on your own machine, offline-first.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Linux%20%7C%20Docker-111827?style=for-the-badge" alt="macOS Linux Docker" />
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-2563eb?style=for-the-badge" alt="PolyForm Noncommercial 1.0.0" />
</p>

---

Library and laboratory — which is what the name is and what the thing is: a workbench for the PDFs you already own.

Take a book apart, clean up the OCR, translate or rewrite a chapter, pick a voice, and put it back together as a chapter-marked M4B audiobook — or as a read-along book where the narration is highlighted on the page it was printed on.

It runs on your own machine: an Apple Silicon Mac, a Linux box (x86_64 or arm64, CPU is enough), or a single Docker container on a headless server.

**Offline-first, not offline-only.** Every narrator and every AI feature has a local option — the TTS engines run on your own GPU or CPU, and translation, rewrites, cleanup, digests and chat work against Ollama or LM Studio, auto-discovered with no configuration. The cloud is strictly opt-in: add an API key and you can use DeepSeek, OpenAI, Anthropic or Gemini for the AI features, or Cartesia and ElevenLabs for their voices. Add none and, once the models have been downloaded, none of your books or audio ever leaves the machine.

## Intro videos

Short standalone tours, narrated by the app's own synthesized voice — the script is a book inside the app, playing on the right while the demo runs on the left.

| [![The core idea](https://img.youtube.com/vi/OKMiox3nxPY/hq720.jpg)](https://youtu.be/OKMiox3nxPY) | [![Smart features](https://img.youtube.com/vi/GhQW_Ma2qwI/hq720.jpg)](https://youtu.be/GhQW_Ma2qwI) |
| :--: | :--: |
| **[1 · The core idea](https://youtu.be/OKMiox3nxPY)**<br>PDF in, chapter-marked audiobook out | **[2 · Smart features](https://youtu.be/GhQW_Ma2qwI)**<br>Ask AI, chat with citations, translate & transform |
| [![Scaling your library](https://img.youtube.com/vi/g9kX_cNFD6k/hq720.jpg)](https://youtu.be/g9kX_cNFD6k) | [![Documents and read-along](https://img.youtube.com/vi/os3-bJxDhsM/hq720.jpg)](https://youtu.be/os3-bJxDhsM) |
| **[3 · Scaling your library](https://youtu.be/g9kX_cNFD6k)**<br>Instant indexing, library-wide chat, digests | **[4 · Documents and read-along](https://youtu.be/os3-bJxDhsM)**<br>PDF/EPUB export, synced read-along for your phone |
| [![Extensions and the road ahead](https://img.youtube.com/vi/fmIiWdthnfg/hq720.jpg)](https://youtu.be/fmIiWdthnfg) | |
| **[5 · Extensions and the road ahead](https://youtu.be/fmIiWdthnfg)**<br>The JSON API, scripted audiobooks, what's next | |

## What it does

- **PDF → audiobook** — chapter detection, per-chapter synthesis, one M4B with native chapter markers and cover.
- **Instant uploads** — raw text in seconds; the slow OCR-capable extraction is opt-in.
- **Per-chapter control** — edit, re-synthesize, exclude, queue, AI-clean the OCR, redraw chapter boundaries.
- **Translate & rewrite** — per-chapter variants in any configured model, each with its own audio. The original is never overwritten.
- **Ask AI & notes** — answers save as notes, and any note can become a chapter of the book.
- **Library chat** — search the *content* of every book and get answers with citations you can click into the PDF.
- **Digest books** — pick N books, get one synthetic book with an AI summary chapter per source.
- **Read along** — narration over the original PDF page, each sentence highlighted where it is printed.
- **Export** — selected chapters as PDF, EPUB, or a synced EPUB that plays on your phone.
- **Library organization** — nested folders, drag & drop, cross-folder search, separate profiles per person.
- **JSON API** — plain endpoints so scripts and other projects can create books straight to audio.

<details>
<summary><b>Turning a book into audio, in detail</b></summary>

**Chapter detection** runs deterministic tiers first, with optional LLM TOC detection on top; boundaries can also be drawn by hand. Every upload gets instant `pdftotext` raw text, so a book is browsable in seconds — the slow Marker extraction (OCR-capable) is opt-in and can run later, or never.

**Per chapter** you can edit the text, re-synthesize, include or exclude it, suspend and queue it, and run AI cleanup over OCR artifacts. Chapter text falls back `customText ?? cleanText ?? rawText` at synthesis time. Assembly produces a single M4B with native chapter markers and a cover.

</details>

<details>
<summary><b>Translations, rewrites, Ask AI and digests, in detail</b></summary>

**Variants are first class.** A variant is either a translation (per language) or a rewrite — ELI5, shortened, summary, enriched-with-examples presets, or any custom prompt — produced by any configured AI model, with its own TTS audio and its own assemblies. The original text is always preserved. Generation streams into the side-by-side view token by token; model reasoning is off by default for speed, and a Reasoning checkbox turns it on and streams the thinking too.

**Ask AI** takes whole-book or per-chapter prompts. Every answer is auto-saved as a note on the book, and any note can be appended to the book as a chapter of its own — ready to reorder and synthesize.

**Digest books**: select N books and get one synthetic book with an AI summary chapter per source, ready to synthesize.

</details>

<details>
<summary><b>Library chat and search, in detail</b></summary>

`/chat` is an agentic assistant that searches the *content* of every book — hybrid full-text + semantic search over local BGE-M3 embeddings. It is cross-language: ask in English and it finds the Bulgarian passage, and the other way round. Answers stream with verified citations; click a source chip to open the PDF at that page, the chapter, or the translation view. Any answer can be saved as a note. See [docs/library-search.md](docs/library-search.md).

Library organization around it: nested folders with drag & drop, cross-folder search, and lightweight profiles (workspaces) so different people keep separate libraries.

</details>

<details>
<summary><b>Read-along and document export, in detail</b></summary>

**On the page**: open a book's narration over its own PDF page — the sentence being spoken is highlighted where it is printed, and tapping a sentence seeks the audio to it. Column view crops pages to their text columns, Text view reflows at your own size, and phone-width presets say whether the book's type is actually readable on a phone. Format in [docs/read-along.md](docs/read-along.md); what each kind of chapter and each TTS engine actually gets is in [docs/read-along-variations.md](docs/read-along-variations.md).

**Export** selected chapters as PDF or EPUB (Vivliostyle), or as a **synced EPUB** — EPUB 3 with Media Overlays: embedded audio plus sentence-level highlighted text, valid per epubcheck.

**On an iPhone**: a self-hosted [Storyteller](https://storyteller-platform.dev/) companion (see `storyteller/`) auto-imports synced EPUBs, and the free Storyteller Reader app downloads them for fully offline listening with live text highlighting.

</details>

<details>
<summary><b>The JSON API — and turning Hacker News into a podcast</b></summary>

Plain JSON endpoints (`POST /api/books`, see [docs/synthetic-books-api.md](docs/synthetic-books-api.md)) let scripts and other projects create synthetic books and chapters, with optional straight-to-audio synthesis.

Ships with `scripts/hn-top10.mjs`, which turns any day's top Hacker News stories (via hckrnews.com archives) into a podcast-style book — one chapter per story in an American network-news register (anchor slug with the day and that day's rank, hook, headline reveal), article text extracted with Defuddle, community reaction capped at 20%.

</details>

<details>
<summary><b>How is this different from Ebook2Audiobook?</b></summary>

[Ebook2Audiobook](https://github.com/DrewThomasson/ebook2audiobook) is a one-shot converter: file in, audiobook out, with voice cloning (XTTSv2) and huge language coverage. Libratory is a **library you live in**: books persist in a database with per-chapter editing, re-synthesis, AI cleanup, translations and rewrites, notes, digests, read-along export, and chat over the content of every book. PDFs are the first-class input (raw text instantly, OCR opt-in) rather than routed through an EPUB conversion, and the TTS stack is newer local models (Kokoro, KugelAudio) plus macOS and Cartesia voices instead of the Coqui-era engines.

If you want "this EPUB in a cloned voice", use Ebook2Audiobook. If you want to clean up, restructure, transform, and actually work with a messy PDF collection, that's this.

</details>

## Quick start

### Docker — Linux, Windows, or a headless server

```bash
git clone https://github.com/subev/libratory.git && cd libratory
docker compose --profile app up -d --build   # Postgres + the app on one port
```

Web UI and API share http://localhost:3034. One container holds the server, the built web UI and both Python environments (CPU-only torch, so no multi-gigabyte nvidia downloads).

### From source — macOS or Linux

```bash
git clone https://github.com/subev/libratory.git && cd libratory
pnpm run setup    # deps, .venv, model cache, Postgres, migrations
pnpm dev          # server on :3034, web on :3033
```

Install first: `ffmpeg`, `poppler`, `espeak-ng`, Python 3.12, Node, pnpm, and Docker (for Postgres). On a Mac that's `brew install ffmpeg poppler espeak-ng python@3.12 node pnpm`; on Linux use your package manager — `pnpm run setup` names whatever is missing.

### Desktop app — macOS

```bash
pnpm app        # build and install over /Applications (~15 s)
```

Signed and notarised; installs its own runtime, so a fresh clone needs nothing installed globally. Docker is the one thing it cannot install for you.

<details>
<summary><b>Prerequisites in full</b></summary>

An Apple Silicon Mac, or a Linux machine (x86_64 or arm64, CPU is enough), or Windows through Docker Desktop and WSL2. The two MLX narrators (KugelAudio, BG-TTS V5) need Metal and stay Mac-only — the UI greys them out with the reason; Kokoro, Pocket, Meta MMS and the cloud voices run everywhere.

- **Mac**: [Homebrew](https://brew.sh), then: `brew install ffmpeg poppler espeak-ng python@3.12 node pnpm` — for running from source, which spawns `ffmpeg` and `pdftotext` off your `PATH`. The packaged app carries its own copies and needs none of this.
- **Linux (from source)**: `ffmpeg espeak-ng poppler-utils zip unzip python3.12 node pnpm` from your package manager — `pnpm run setup` names whatever is missing. Or skip all of it and run the Docker image.
- Docker — [OrbStack](https://orbstack.dev/) or Docker Desktop on a Mac, Docker Engine on Linux (Postgres, and optionally Storyteller). The desktop app will require it too.
- Optional: an AI model for translation, rewrites, cleanup, digests, Ask AI, chat, and LLM chapter detection — [Ollama](https://ollama.com) or LM Studio running locally (auto-discovered, fully offline), or a [DeepSeek](https://platform.deepseek.com/) / OpenAI / Anthropic / Gemini API key.
- Optional: a [Cartesia](https://cartesia.ai) or [ElevenLabs](https://elevenlabs.io) API key for their cloud voices.
- Optional: a [HuggingFace](https://huggingface.co) account for Pocket TTS **voice cloning** — accept the terms at [kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts) and put a read token in `HF_TOKEN`. The 26 built-in Pocket TTS voices need no account and no token.

</details>

<details>
<summary><b>What <code>pnpm run setup</code> actually does</b></summary>

It is idempotent — rerun it after failures. It works the same on Linux, minus the KugelAudio prompt (Metal-only). It must be `pnpm run setup`; bare `pnpm setup` triggers pnpm's unrelated builtin.

- Creates `.env` with working defaults.
- Skips the ~17 GB KugelAudio narrator download unless you answer yes (or run `pnpm run setup --kugel`).
- Installs Python packages into a repo-local `.venv` from `pyproject.toml` + `uv.lock` (`uv sync --frozen`, whole graph pinned). Point `CONDA_ENV_PATH` in `.env` at another env's `bin` dir if you manage your own.

**For the AI features you need at least one model.**

- *Offline-first (recommended)*: install [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com) and download a chat model — a current ~27-30B reasoning model (e.g. Qwen3.8 27B, ~16 GB) is a strong offline pick on 32 GB+ Macs; use an 8B-class model on smaller machines. Running servers and their models are auto-discovered, zero config.
- *Cloud*: add an API key for DeepSeek / OpenAI / Anthropic / Gemini.

The ⚙️ button on the home page opens Settings: it shows which local servers were detected (with each model's usable context size), can start a stopped server, and holds every API key — AI providers and the Cartesia/ElevenLabs cloud voices alike (written to `.env`, applied without a restart). Custom OpenAI-compatible servers (`mlx_lm.server`, llama.cpp) can be added via `LOCAL_LLM_URL` + `LOCAL_LLM_MODEL`. Every available model appears in the in-app model pickers.

</details>

<details>
<summary><b>Docker: volumes, ports, and exposing it beyond localhost</b></summary>

Nothing in the image is Linux-specific, so the same two commands are also the Windows route, through Docker Desktop with the WSL2 backend — that path is new, so [open an issue](https://github.com/subev/libratory/issues/new) if it does not work. Migrations apply at boot, and the first boot caches the essential Kokoro voice (~350 MB) before the server starts. The library lives in the `data` volume, every lazily-downloaded model in the `models` volume — backing those two up is the whole story. API keys set in ⚙️ Settings persist in `/data/.env`.

The port is published on **127.0.0.1 deliberately**: there is no login, so anyone who can reach it can read and delete everything. Postgres is bound the same way, and for the same reason — its password is the default `libratory`. To serve your LAN, replace the mapping in a `docker-compose.override.yml` (`ports: !override ["3034:3034"]` — Compose *appends* a plain `ports` entry, and the second binding then fails on the port the first already holds) — and know who is on that network — or front it with a reverse proxy or Tailscale.

The server tells browsers apart from strangers by matching their `Origin` against the Host they asked for. Reaching it by address — `http://192.168.1.50:3034`, `http://100.x.y.z:3034` — needs no configuration. Reaching it by *name* does: set `TRUSTED_HOSTS=library.example.com` (comma-separated, `host:port` when it is not the default port), because a name that vouches for itself is exactly what a DNS-rebinding page sends. A reverse proxy must also forward the original `Host` header (nginx: `proxy_set_header Host $host;` — Caddy already does), or every browser POST looks foreign and gets rejected.

</details>

<details>
<summary><b>Optional: Storyteller companion (read-along on a phone)</b></summary>

```bash
cd storyteller
openssl rand -base64 32 > STORYTELLER_SECRET_KEY.txt
docker compose up -d          # web UI + API on http://localhost:8001
```

Create the admin account at `http://localhost:8001`, then set `READALOUD_DROP_DIR=<repo>/storyteller/data/import` in `.env` — the "Copy to Storyteller import folder" checkbox on synced-EPUB exports will drop files there and Storyteller auto-imports them. Install the free **Storyteller Reader** iOS/Android app and point it at your Mac's LAN address on port 8001.

</details>

## Languages

Every engine covers a different set, so the answer to "does it do language X" depends on which one you pick. Local engines, unless noted:

| Language | Voices | Engine |
| --- | --- | --- |
| English | 27 + 26 | Kokoro, Pocket TTS |
| Spanish, Italian, German, Portuguese, French | 26 each | Pocket TTS (downloadable from the picker) |
| Bulgarian | 3 + system | BG-TTS V5 MLX, MMS Bulgarian, KugelAudio, macOS `Daria` |
| French, Spanish, Italian, Brazilian Portuguese | 2 each | Kokoro |
| Hindi | 4 | Kokoro |
| Mandarin Chinese | 8 | Kokoro |
| 24 EU languages | 1 multilingual narrator | KugelAudio (opt-in ~5 GB download) |
| Most others | many | [Cartesia](https://cartesia.ai) and [ElevenLabs](https://elevenlabs.io) (cloud, need an API key), plus any macOS system voice you have installed |

![Scrolling the voice picker's Italian list: 49 voices grouped under Kokoro, Pocket TTS, KugelAudio, macOS system voices and Cartesia](docs/images/voice-picker-languages.gif)

The picker leads with the language, not the engine: pick Italian and you get every voice that can read it — 49 here, grouped by engine, with a preview button on each one.

<details>
<summary><b>Notes on the edges</b></summary>

- **Japanese is not supported**, even though Kokoro ships Japanese voices. They need a MeCab/`fugashi` native stack plus a ~700 MB dictionary, and the extra downgrades a package the Marker/spaCy side depends on. Not worth it for five voices — so they aren't listed in the picker.
- **Pocket TTS ships one checkpoint per language**, and only English is installed by `pnpm run setup`. The others download on demand: open the picker's Pocket TTS tab, pick a language, and press Download — it shows the size first (~370 MB each, **~800 MB for French**, which has no distilled build yet and runs ~2.5x slower). Downloads land in the shared HuggingFace cache and go live immediately; no server restart.
- **Pick the matching language.** The English model will happily read French or Italian text and produce something that sounds plausible, because the voices include non-English *speakers* (Giovanni, Lola, Juergen, Rafael, Estelle). It mispronounces silent letters and liaisons — the same French sentence runs 25% longer on the English model than the French one. Selecting the language is what makes it correct, not selecting a native-sounding voice.
- Mandarin needs the `misaki[zh]` G2P chain, which `pyproject.toml` pins and `pnpm run setup` installs.

</details>

<details>
<summary><b>Book language</b></summary>

Books carry an optional language, set from **Extract... → About this book**. It's a plain field you pick yourself — nothing infers it — and it decides which voices the picker offers first, so a Russian PDF opens on Russian voices instead of English ones. Leave it unset and the picker falls back to the language of whatever voice is currently selected.

</details>

<details>
<summary><b>Cloning your own voice</b></summary>

Pocket TTS can clone a voice from a short sample. In the voice picker, open **Your voices**, then either record ~20 seconds in the browser or upload a file (anything ffmpeg can read). The sample is encoded locally into a small voice file and the recording is discarded — it never leaves the machine running Libratory.

![The Your voices tab of the voice picker, listing cloned voices above the recording controls](docs/images/voice-cloning.png)

**Set your expectations accordingly.** Pocket TTS is a 100M-parameter model built to run on a CPU, and a clone inherits that ceiling — it lands somewhere between recognisable and convincing, and it is not as easy to listen to across a whole book as Kokoro's built-in voices. It also reproduces the *recording* faithfully, so room echo and mic hiss get cloned along with the voice. A quiet room and a headset mic help; on iPhone, Voice Memos set to **Studio** quality gives a noticeably cleaner sample. It's a fun extra rather than the voice you'd pick for a long listen.

Kyutai's terms prohibit cloning a voice without that person's consent, along with deception and impersonation generally — hence the confirmation checkbox, which the server enforces rather than takes on trust. Enabling cloning means accepting those terms on your own HuggingFace account, and if you host Libratory for other people, enforcing them becomes your responsibility.

</details>

## How it works

```
Upload → rawExtract (pdftotext, seconds, always)
       → extract (Marker, opt-in, OCR-capable) → normalize → synthesize (TTS) → assemble → M4B
       → translate/transform → synthesizeTranslation → per-variant assembly
       → assembleDocument → PDF / EPUB / synced EPUB
```

Jobs run through [Graphile Worker](https://github.com/graphile/worker) in six pools (TTS, raw text, extraction, assembly, AI/translation, search indexing) with `maxAttempts: 1` — nothing retries silently; the user reviews failures and decides.

<details>
<summary><b>TTS engines and sync maps</b></summary>

**Local, GPU-accelerated via MPS/Metal:** [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (English, French, Spanish, Italian, Brazilian Portuguese, Hindi, Mandarin), KugelAudio (24 EU languages incl. Bulgarian, local 4-bit MLX quant), BG-TTS V5 MLX, and Meta MMS Bulgarian.

**Local, CPU:** [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) from Kyutai (100M params, ~12x realtime, 26 built-in voices, optional voice cloning from a ~20s sample), and every installed macOS system voice (via `say`, free and ~25x realtime).

**Cloud, optional:** [Cartesia](https://cartesia.ai) Sonic (`CARTESIA_API_KEY`) and [ElevenLabs](https://elevenlabs.io) (`ELEVENLABS_API_KEY`, whose free tier is 10,000 characters a month — synthesis checks what is left and refuses before spending rather than stopping halfway).

During synthesis the server keeps a text↔audio timing map (`chNNN.sync.json`) next to each chapter's M4A — per chunk always, and per word where the engine reports it (Kokoro does, straight out of its own duration prediction). That map powers the web UI's read-along player and the synced EPUB export — and once it is written, the worker deletes the intermediate chunk WAVs to reclaim disk (`pnpm --filter server cleanup:chunks` sweeps leftovers from older runs).

</details>

<details>
<summary><b>Project structure, database, and file storage</b></summary>

### Project structure

pnpm monorepo: `packages/server` (Fastify + tRPC + Graphile Worker + Drizzle/Postgres, port 3034) and `packages/web` (React 19 + Vite + Tailwind v4 + react-router 7, port 3033). Python TTS/extraction scripts live in `scripts/`; the optional Storyteller companion in `storyteller/`.

**The detailed, maintained map of files, tables, routes, and pipeline internals is in [AGENTS.md](AGENTS.md)** — this README stays intentionally high-level.

### Database

PostgreSQL 17 with pgvector in Docker (`pgvector/pgvector:pg17`, host port **5433**, to avoid conflicts with other Postgres instances on 5432), schema via Drizzle ORM: `profiles`, `folders`, `books`, `book_files`, `chapters`, `chapter_translations`, `assemblies`, `documents`, `notes`, `book_logs`, `book_chunks` (search index: FTS + embeddings). See AGENTS.md for column-level docs. Migrations: `pnpm db:generate` + `pnpm db:migrate`.

The server applies pending migrations at boot, so a fresh database needs nothing by hand — the app depends on that, having no `drizzle-kit` in the bundle. To index an existing library for search, run `pnpm backfill:index` (FTS is available within minutes; BGE-M3 embeddings fill in as a background pass).

**Postgres runs in Docker, deliberately.** It was briefly bundled instead (`scripts/pg.sh`, removed in 2026-08) and that worked — the whole 5 GB library migrated in three minutes, and `tasks/desktop-app.md` records what it took. Docker won because the desktop app is going to require it anyway, and one database path beats two: the app would otherwise be tested against binaries the developers never run.

### File storage

All runtime data lives in `./data/` (gitignored, resolved relative to `packages/server`):

```
data/uploads/{bookId}/            Uploaded PDFs
data/tmp/{bookId}/                Marker JSON output
data/output/{bookId}/             Chapter M4As + sync maps, M4B assemblies, exported documents
data/output/{bookId}/{slug}/      Variant audio (language or transform slug)
data/output/{bookId}/chunks/      Chunk WAV previews (disposable once sync maps exist)
data/previews/                    Voice preview M4As
```

</details>

<details>
<summary><b>Models: what downloads when</b></summary>

- Every TTS/extraction subprocess runs with `HF_HUB_OFFLINE=1`, so models never download at synthesis time. `pnpm run setup` caches only what the core path needs — **Kokoro-82M, ~350 MB**. The heavy optional bundles arrive at the doorway of the feature that needs them, with a size and a button: **Marker/Surya 5.1 GB** (full extraction and OCR), **BGE-M3 4.3 GB** (library search and chat), **Bulgarian narrators 1.2 GB**. `WITH_ALL_MODELS=1 pnpm run setup` fetches everything up front instead — setup used to do that unconditionally, which meant ~15 GB and an hour before the app could open a page.
- `scripts/models.py --status` lists the bundles and what is cached; `--download <id>` fetches one; `--capabilities` reports whether MLX is usable, which is what greys out the two Metal-only narrators (BG-TTS V5 and KugelAudio) instead of letting them fail at synthesis. Everything else falls back to the CPU. A `.models-missing` file at the repo root (one bundle id per line) makes the app pretend those are absent — the only sane way to work on a download gate without deleting gigabytes.
- The first PDF/EPUB export downloads a rendering browser (~350 MB) into the Vivliostyle cache.
- Python dependencies are a **uv project**: `pyproject.toml` + `uv.lock` at the repo root, installed with `uv sync --frozen` (setup fetches `uv` into `.uv/` if it is missing). 189 packages resolve in under two seconds and install in about thirteen. Four pins deliberately contradict what `mlx-audio` and `nanocodec-mlx` declare — transformers 5.x breaks marker, huggingface_hub 1.x is untested here, nanocodec wants an older mlx, and numpy must stay on 1.x — and those are `[tool.uv] override-dependencies` rather than the `--no-deps` installs they used to be.
- **Pocket TTS** runs in its own Python env (`.venv-pocket`) because it needs numpy 2.x while the marker/kokoro stack is pinned to 1.26. `pnpm run setup` builds both. It is CPU-only by design — it leaves the GPU free for the MLX engines — and has no speed parameter, so the UI disables the slider.
- KugelAudio (`kugelaudio/kugelaudio-0-open`, Apache-2.0) runs from a local 4-bit MLX quantization (~5 GB) at `~/.cache/libratory-models/kugelaudio-0-open-4bit` (override with `KUGEL_TTS_MODEL_PATH`); `pnpm run setup --kugel` downloads and converts it. ~1.5x realtime on an M4 Pro.
- The Bulgarian-capable narrators are `BG-TTS V5 (Radi Totev MLX port)`, `MMS Bulgarian (Meta)`, `KugelAudio (7B, 24 EU languages)`, the macOS `Daria` system voice, and the Bulgarian voices from Cartesia and ElevenLabs. The local model narrators run at fixed speed (UI disables the slider); macOS and the cloud engines support the speed control.
- Best Kokoro voices: `af_heart` (A tier), `af_bella` (A- tier), `bf_emma` (B- tier).

**Voice licensing.** `facebook/mms-tts-bul` is licensed `CC-BY-NC-4.0`. Pocket TTS built-in voices are embeddings of real recordings under mixed licenses: most are CC0 or CC BY 4.0, but `cosette` and `jean` are **CC BY-NC 4.0 (non-commercial only)** and `estelle`'s provenance is unverified. Each voice shows its license in the picker. This is irrelevant while Libratory is noncommercial (see [LICENSE.md](LICENSE.md)) — it matters if you ever sell audio made with it. Details in [docs/tts-licensing.md](docs/tts-licensing.md).

</details>

## Development

```bash
pnpm dev          # server on :3034, web on :3033
pnpm lint         # oxlint — under a second, and runs first in CI
pnpm test         # unit tests for both packages
```

<details>
<summary><b>Every command</b></summary>

```bash
pnpm dev              # Start server + web in parallel
pnpm dev:server       # Server only (port 3034)
pnpm dev:web          # Web only (port 3033)
pnpm db:up            # Start Postgres in Docker
pnpm db:down          # Stop Postgres
pnpm db:generate      # Generate Drizzle migration from schema changes
pnpm db:migrate       # Apply migrations
pnpm run setup        # Full setup (deps check, .venv + pinned Python deps, model caching, Postgres + migrations)
pnpm jobs             # Show Graphile Worker queue status
pnpm jobs:clear       # Delete all queued jobs
pnpm lint             # oxlint over packages, scripts, e2e — under a second, and runs first in CI
pnpm lint:fix         # ...and apply what it can fix itself
pnpm typecheck        # tsc --noEmit across every package
pnpm test             # Unit tests for both packages (server spins up a template DB, runs migrations)
pnpm e2e:smoke        # Playwright e2e, fast tier (needs the dev server running; see e2e/README.md)
pnpm e2e:full         # Everything incl. slow tests (marker, TTS, exports)
```

</details>

<details>
<summary><b>Desktop app internals</b></summary>

`packages/desktop` builds a macOS app that installs its own runtime — no checkout, no terminal:

```bash
pnpm app        # build and install over /Applications, quarantine cleared (~15 s)
pnpm app:dmg    # the same, plus a DMG to hand to someone
```

It fetches Bun and bundles ffmpeg/pdftotext/pdfinfo on first run, so a fresh clone needs nothing installed globally. `--install` matters more than it sounds: without it you end up reading the behaviour of whatever is in `/Applications` while editing the build in `release/`.

On first launch it checks Docker, brings up Postgres, downloads `uv`, builds the Python environment from `uv.lock`, fetches the Kokoro voice, and starts the server — which serves the UI too, so there is one port and no Vite. About 2.4 GB downloaded once — 1.4 GB of Python and PyTorch, the 347 MB Kokoro voice, and the 644 MB Postgres image; later launches take seconds. **Docker is the one thing it cannot install for you**, and the first-run screen says so rather than failing — it explains what Docker is and links to Docker Desktop and OrbStack, rather than naming a prerequisite and stopping.

API keys go in **⚙️ → Settings** — AI providers under *Cloud providers*, Cartesia and ElevenLabs under *Cloud voices*. They are written to a `.env` file, named at the bottom of that panel, which the app keeps beside everything else it installed. There is nothing to edit by hand and no checkout required.

Running the app **and** `pnpm dev` against the same Docker Postgres needs one more thing: `~/Library/Application Support/Libratory/config.json`.

```json
{
  "dataDir": "<repo>/packages/server/data",
  "envFile": "<repo>/.env"
}
```

The database stores absolute paths to audio and PDFs, so both halves must use the same `DATA_DIR` or the app lists your books and cannot play them. `envFile` is the same idea for secrets: without it the app has its own `.env`, and a key you added under `pnpm dev` is invisible to the app.

A crash writes `crash.log` beside the app's data and offers to open a prefilled GitHub issue. Updates come from GitHub Releases via `electron-updater`, and the launch after one brings the Python environment forward to match — see `tasks/desktop-updates.md`.

It is signed with a Developer ID certificate and notarised by Apple, so the download opens with no warning and the in-app updater can install what it finds. Releasing is a version bump and a `v*` tag; the steps are in [packages/desktop/README.md](packages/desktop/README.md#releasing). `scripts/vm-verify.sh` runs the whole thing inside a fresh macOS VM, checking first that the VM has no Homebrew, no Python and no cached models — this machine has all three and hides bugs because of it.

</details>

<details>
<summary><b>Uninstall — and where the 27 GB actually lives</b></summary>

A full install with every model downloaded reaches about **27 GB**, and almost none of it is inside the app bundle — dragging `Libratory.app` to the Trash leaves roughly 26 GB behind. Everything the app installs is listed here so you can remove exactly as much as you mean to.

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

</details>

## License

Copyright © 2026 Petar Sabev, licensed under [PolyForm Noncommercial 1.0.0](LICENSE.md) — the source is public, and you're free to use, modify, and share Libratory for personal and any other noncommercial purpose. Commercial use of any kind requires permission from the licensor — [open an issue](https://github.com/subev/libratory/issues/new) to ask.
