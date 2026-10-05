# ElevenLabs in Libratory — how it is used, why, and what is left on the table

Written 2026-10-05. Part one describes the code as it stands. Part two is research into the current
ElevenLabs API. One caveat applies to part two: the research proxy blocked `elevenlabs.io`, so the
docs, the pricing page and the changelog could not be read directly. Every claim there carries a
source tag:

- **[SDK]** comes from the official `elevenlabs/elevenlabs-python` client. That client is generated
  from the OpenAPI spec, so its docstrings are the API reference.
- **[3rd]** comes from search summaries, community code or news. It is unverified until a live key
  confirms it.

Anything priced or dated in part two should be checked against a live key before code depends on it.

## Part one — how it is used

### Where it sits

ElevenLabs is one of two cloud engines, beside Cartesia. The other engines are Kokoro, Pocket, the
Bulgarian narrators, KugelAudio and macOS `say`, and all of them are free and local. ElevenLabs is
reached through the `elevenlabs:<voice_id>` prefix.

| piece | what it does |
| --- | --- |
| `packages/server/src/lib/elevenlabs.ts` | the client: voice listing, quota, character-to-word grouping, synthesis |
| `routes/elevenlabs-voices.ts` | tRPC `elevenlabsVoices.list` / `quota` |
| `lib/tts.ts` | parses the `elevenlabs:` prefix, dispatches, maps `ElevenLabsAbortedError` to `TtsAbortedError`, makes previews one sentence long |
| `lib/voice-catalog.ts` | `ENGINE_PREFIXES` row (speed supported); `voiceHasWordTiming` returns true |
| `lib/secrets.ts` | `ELEVENLABS_API_KEY` is settable from Settings → Cloud voices, so the desktop app can reach it |
| `env.ts` | `ELEVENLABS_MODEL`, default `eleven_multilingual_v2` |
| `lib/mcp-server.ts` | `synthesize_book` returns a billed-character estimate for metered voices, plus `dryRun` |
| `VoiceLibraryModal.tsx` | the ElevenLabs section header shows "N of M characters left" |
| `scripts/elevenlabs-check.mjs` | an end-to-end key check that costs about 44 characters |

### What one chapter's synthesis does

1. `chunkTextForTts` packs the text into chunks of about 285–320 characters (`NARRATOR_CHUNKS`).
2. Chunks already on disk are counted as paid, and the remaining characters are multiplied by the
   model's credits per character.
3. **Preflight.** `GET /v1/user/subscription` is read, and the run **refuses before spending** if
   the credits will not cover it. The local spend since the last read is subtracted, because their
   balance lags about 10 s.
4. Each chunk is sent, one after another, to `POST /v1/text-to-speech/{id}/with-timestamps` with
   `output_format=pcm_24000`.
   - `speed` is clamped to 0.7–1.2.
   - `language_code` is deliberately absent: the voice's language is not the book's.
5. `charactersToWords` groups the character alignment into `ChunkWord`s. The whitespace each word
   carries in `after` is the real whitespace from the text. If the characters do not rejoin to the
   exact request text, the chunk gets no word timings rather than wrong ones.
6. Each chunk's WAV is cached on disk, so a restart in the middle of a paid chapter never pays twice.
   250 ms of silence goes between chunks.

### What it is used for in practice

- **Demo and public-facing narration.** The demo book, the website and the intro videos are what
  strangers hear, and ElevenLabs is the quality ceiling. That was the stated reason it was added
  (`tasks/elevenlabs.md`).
- **Bulgarian with word timing.** It is the part that turned out to matter most. None of the local
  Bulgarian narrators returns word timestamps, so word-level read-along and bilingual reading of a
  Bulgarian lane needs a cloud voice. The end-to-end bilingual walk-through on 2026-09-29 narrated
  its Bulgarian lane with ElevenLabs multilingual, because Cartesia had run out of credits
  (`docs/two-languages-implementation-progress.md`).
- **Short runs on a free or small plan.** A free month is 10,000 credits, about ten minutes of
  audio. A ten-hour book is roughly $25–51 at list overage. It is an opt-in lane, not a library
  engine (`docs/tts-licensing.md`).

### Why it is the favourite cloud engine

- **The best alignment of any engine here.** Timing is per character, not per word, which makes
  three things possible:
  - Whitespace round-trips exactly.
  - The text sent can be verified against what came back, which no other engine allows.
  - `alignment` describes the text as sent, and `normalized_alignment` is ignored. The cue text
    therefore stays findable in `cleanText` and keeps its rectangles on the page.
- **Timestamps on every model.** This was measured, not read: `eleven_v3` returns them although the
  docs' table implies it does not.
- **Bulgarian is good, and it is timed.** No local engine offers both.
- **Billing can be read before spending.** The subscription endpoint makes a refuse-before-spending
  preflight possible. Cartesia has no equivalent, and the MCP dogfood run hit exactly that gap
  (`docs/mcp-dogfood-bilingual-2026-09-30.md` finding 3).
- **24 kHz PCM on every tier, and a free key with no card.** The audio format never depends on the
  plan, and anyone can try it.
- **Speed control**, which the local narrators lack.

## Part two — what is not being used yet

Ordered by how much each would change for Libratory.

### 1. Request stitching — the biggest quality gap

**What the code does today.** Chunks are about 300 characters, each request is independent, and
`previous_text`/`next_text` are not sent. The cost is prosody: each chunk starts fresh, and the
250 ms gap papers over the join.

**What the API offers [SDK].** `previous_request_ids` and `next_request_ids` take up to 3 ids each.
The ids come from the `request-id` response header. With the ids, the model continues the earlier
audio itself rather than re-reading context text.

**Model support:**
- `eleven_multilingual_v2`, `flash_v2_5` and (per [3rd]) `eleven_v4`: supported.
- `eleven_v3`: answers **400** to both request ids and `previous_text` [3rd, two independent
  codebases].
- With `enable_logging=false`, stitching is unavailable.

**Unknowns.** Whether context characters are billed is still not verified. The `character-cost`
header (item 3) answers that with one test call. The [3rd] reports also say ids must be fully
processed and under 2 hours old. Cached chunks from yesterday's run cannot be stitched to, so a
resumed chapter has a seam at the resume point. That is acceptable.

**What a change would look like.** Store each chunk's `request-id` beside its WAV, send the previous
1–3 ids, and skip stitching on v3. It is cheap to try and directly audible.

### 2. Bigger chunks

**The limits.** `multilingual_v2` and `eleven_v4` take 10,000 characters per request, and `flash_v2_5`
takes 40,000.

**Why the chunks are small today.** The chunk size came from the fixed-length Bulgarian narrator, not
from ElevenLabs. Larger chunks (about 1,500–3,000 characters) mean fewer seams and fewer requests.

**What they cost.** A failure re-pays more, and chunk previews get coarser. Do this together with
stitching or instead of it; it would be the `CLOUD_CHUNKS` limit that `tasks/elevenlabs.md` already
floated.

### 3. Read the real cost from the response

**What the API offers [3rd + code].** Every TTS response carries `character-cost`, the characters
actually charged.

**What the code does today.** `recordElevenLabsSpend` estimates the charge as `text.length ×
creditsPerChar`. The header is free truth:
- It fixes the preflight drift.
- It settles the stitching-billing question.
- It gives the assistant panel the "real usage" cost line that `tasks/assistant-panel.md` asks for.

### 4. Model table housekeeping

- **`eleven_turbo_v2_5` is deprecated** [3rd: "outclassed by Flash"], yet `MODELS` still offers it.
  Drop it, or map it to `flash_v2_5`.
- **`eleven_v4` was released 2026-09-28** [3rd; after this repo's last check, unverified here].
  - Claimed features: 90+ languages including Bulgarian, 10,000 characters per request,
    timestamps, request stitching, free-form audio tags.
  - Claimed pricing: 1 credit per character like v3, a Turbo variant at half price, and a launch
    discount until 2026-10-12.
  - It looks like a strong replacement for v2 as the default, especially for Bulgarian. **Verify
    with `scripts/elevenlabs-check.mjs --model eleven_v4`** before adding it to `MODELS`.
  - One trap: tag text such as `[warm]` appears in the alignment with its own timing. Libratory
    never sends tags, so today it would not matter. If tags are ever added, `charactersToWords` must
    drop bracketed spans, or they become "words" in the read-along.
- **Model choice is per server.** `ELEVENLABS_MODEL` is a single env var. Picking the model in the
  Synthesize dialog, beside the voice, would let a Bulgarian lane use v4 while a cheap draft uses
  Flash.

### 5. Pronunciation dictionaries

**What the API offers [SDK].** `pronunciation_dictionary_locators` takes up to 3 PLS dictionaries per
request, with alias rules or phoneme rules.

**Which models honour phoneme rules [3rd]:**
- `eleven_flash_v2` (English), `v3` and `v4` honour them.
- `multilingual_v2` and `flash_v2_5` ignore them, so use alias rules there.

**Why it fits.** Names, invented words and Bulgarian stress are what an audiobook gets wrong, and a
per-book dictionary is the standard fix. The "custom text" edit is the only lever today, and it
changes the printed text too.

**The catch.** An alias rule changes what is spoken but not the request text, so the alignment
should still rebuild. Verify that before relying on it: if the alignment came back aliased, every
chunk with a substitution would silently lose its word timings.

### 6. Forced alignment — parked, and worth reopening

**What the API offers.**
- [SDK] `POST /v1/forced-alignment` takes audio and a transcript, and returns `words[]` and
  `characters[]` with times plus a `loss` score.
- [3rd] Limits: 10 h, 675k characters and 3 GB per call. 29 languages, Bulgarian included. Billed at
  the speech-to-text rate, which a reseller puts at about $0.22 per audio hour; ElevenLabs' own
  rate is not verified.

**Why it was parked.** `tasks/elevenlabs.md` parked it because BG-MLX audio was not worth aligning.

**Why it is worth reopening.** The case has changed: forced alignment gives **word timing to any
engine** — KugelAudio, Pocket, `say`, Kokoro's non-English voices. That is the gap the
2026-09-29 "which voices time their words" work had to label rather than fix.

### 7. Voice library, design and cloning

**Voice library.**
- [SDK] `GET /v1/shared-voices` has filters for language, accent, `reader_app_enabled`, trending and
  more.
- [SDK] `POST /v1/voices/add/...` adds a library voice to the account.
- [3rd] Library voices do not use custom voice slots, but the API path to them is not on the Free
  tier.
- What it would change: today the picker lists only the account's own voices (`GET /v2/voices`).
  Browsing the library for a native Bulgarian narrator is the obvious use.

**Voice design and cloning [3rd].**
- Voice design (`/v1/text-to-voice/design`) is on Free.
- Instant cloning starts at Starter, and professional cloning at Creator.
- Libratory already clones with Pocket, so this matters only if a premium cloned narrator is
  wanted.

### 8. Smaller items

- **`seed`** [SDK] — best-effort determinism. Re-synthesizing one chunk would come out closer to its
  neighbours.
- **`apply_text_normalization: "off"`** [SDK] — this would read "1943" digit by digit, so it is not
  wanted. `auto` with the original `alignment` is already the correct pairing.
- **History API** [SDK] — `GET /v1/history/{id}/audio` can re-download a past generation, which might
  recover a lost chunk without paying again. Whether a download is free is not verified.
- **Higher-quality output** — 44.1 kHz PCM needs Pro, and MP3 192k needs Creator. The pipeline
  encodes AAC 64k mono, so this would not be audible. Not worth it.
- **Text to Dialogue** [SDK] — multi-speaker, has a `/with-timestamps` variant, capped at 2,000
  characters. A fit only if character voices for dialogue ever become a feature.

### Not a fit

- **Studio / Projects API.**
  - It is the long-form audiobook product, with chapters, loudness normalization and 192k exports.
  - [SDK] Its snapshots return **no timestamps**, which would break read-along.
  - [3rd] API access is by sales request.
- **Dubbing.**
  - [3rd] Roughly $0.33–2.20 a minute.
  - No text timing. Synthesizing the translated text directly is cheaper and keeps read-along.
- **Zero-retention mode** (`enable_logging=false`).
  - Enterprise only, and it disables stitching.
- **ElevenReader Publishing.**
  - [3rd] Distributes audiobooks in their app, with per-listener payouts or 60% royalty sales.
  - That is a publishing decision, not an engineering one. Most books here are other people's
    PDFs, so it applies at most to original work.

## Suggested order

1. Delete `eleven_turbo_v2_5` from `MODELS`, and read `character-cost` instead of estimating.
2. Run the check script against `eleven_v4`, then a Bulgarian A/B (v4 vs multilingual_v2 vs the
   local narrators).
3. Add request stitching on v2/v2.5/v4, with larger chunks.
4. Add per-book pronunciation dictionaries.
5. Reopen forced alignment as "word timing for every engine".
