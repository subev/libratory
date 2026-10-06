# Task: Piper voices — the quality tier of the on-demand language mechanism

## Goal

Add **Piper** as a downloadable local TTS engine alongside the MMS language packs
(`tasks/mms-language-packs.md`). Same on-demand download mechanism, different tradeoff: MMS buys
*breadth* (63 languages, coarse), Piper buys *quality* (50 languages, correct prosody, working
speed control) and covers most of the languages MMS is missing.

If both tasks land, Piper is the **default** for any language both engines have, and MMS is the
fallback that keeps the picker from ever saying "nothing can read this".

## Why Piper and not just more MMS

MMS and Piper are both VITS. The difference is entirely in the **front end**, and it decides
everything that matters for reading a book aloud.

| | MMS (`facebook/mms-tts-bul`) | Piper (`bg_BG-dimitar-medium`) |
|---|---|---|
| Tokenizer | raw chars, **37-token vocab** | espeak-ng phonemes, **162-phoneme vocab** |
| Punctuation | **absent from the vocab — silently dropped** | `. , ! ? : ; ' " ( ) -` all present |
| Numbers | **silently dropped** ("1943" → nothing) | expanded to words, per language |
| Sample rate | 16 kHz | 22.05 kHz |
| Speed control | none | `length_scale` in the inference config |
| Runtime | torch + MPS | ONNX Runtime, CPU only |
| Voices per language | 1 | 1 for 35 of 50 languages; up to 38 (English) |

Verified with the espeak-ng already installed on this machine (`/opt/homebrew/bin/espeak-ng`):

```
bg  "През 1943 година, той каза:"
    → çilˈadɐ dˈevetstˈotin tʃˌetirˈidesˌetitrˈi   ("хиляда деветстотин четиридесет и три")
de  "Im Jahr 1943 kostete es 12 Euro."
    → ˈaɪn tˈaʊzənt nˈɔønhˈʊndɜt dɾˈaɪ ʊntfˈɪɾtsɪç … tsvˈœlf ˈɔøroː
```

So the "digit warning / number expander" work item in the MMS plan **does not exist for Piper** —
espeak-ng handles it upstream in every language, and clause boundaries survive as real pauses
instead of being faked by chunk gaps.

## Verified facts (checked 2026-08-22)

- **`piper-tts` 1.7.0** on PyPI, **GPL-3.0-or-later** (the `piper1-gpl` rewrite by OHF-Voice —
  the old MIT Piper is retired). It runs as a subprocess like every other engine here, so it does
  not affect Libratory's own licensing — but the repo is public, so note it in the docs.
- Prebuilt **`macosx_11_0_arm64`** wheel (cp39-abi3), espeak-ng bundled. **No cp314 wheel** —
  build the venv on **python3.12** (what `.venv` already uses); 3.14 falls back to an sdist build.
- **Measured on this machine: ~20x realtime on CPU** — 16.9s of Bulgarian audio in 0.83s wall,
  cold start included. That is faster than MMS on MPS (~2x) and far faster than KugelAudio (~0.2x).
  Piper being CPU-only is a non-issue; it also means it never contends with Kokoro or BGE-M3 for
  the GPU, so its worker could run outside the `tts` pool's concurrency-2 MLX limit.
- **`length_scale` speed control confirmed working**: 1.0 → 16.9s, 0.8 → 15.0s on the same text.
- Catalogue: **174 voices / 50 languages**, from `rhasspy/piper-voices` `voices.json` — a single
  machine-readable index with per-file sizes and md5s, which is a better generation source than
  MMS's "guess the ISO 639-3 code and probe HF".
- Quality tiers and weights: `x_low` 21–28 MB, `low` 28–70 MB, `medium` 63–79 MB, `high` 63–137 MB.
  120 of 174 are `medium`.
- **Covers what MMS lacks**: Italian, Japanese, Chinese, Czech, Slovak, Serbian, Danish, Norwegian,
  Slovenian, Latvian, Armenian, Georgian, Korean.
- **MMS covers what Piper lacks**: Amharic, Tibetan, Lao, Khmer, Burmese, Malagasy, Luganda,
  Chichewa, Bashkir, Tajik, Yoruba, Hausa, and the rest of the long tail.
- **25 voices are multi-speaker**, up to **904 speakers** (`en_US-libritts_r-medium`). Voice ids
  need an optional speaker index; MMS ids are flat.
- **Licensing is a patchwork** and is per-voice, in each voice's `MODEL_CARD`: 48 CC0, ~25 CC-BY,
  8 public domain, 4 Apache — but **19 noncommercial** (CC BY-NC-SA, plus the Data-Baker Chinese
  voice), one **AGPLv3**, and 24 that only say "See URL". This is exactly what
  `docs/tts-licensing.md` already tracks; the licenses are scrapeable, so they belong in the
  generated table rather than a hand-maintained list.

## Packaging gotchas (hit while testing — bake these into `scripts/setup.sh`)

1. **The wheel's espeak-ng data path is broken.** `espeakbridge.so` has the CI build path
   `/Users/runner/work/piper1-gpl/...` compiled in, and passing `espeak_data_dir` to
   `EspeakPhonemizer` does **not** override it — every call dies with
   `Error processing file '.../espeak-ng-data/phontab': No such file or directory`.
   The fix is the **`ESPEAK_DATA_PATH`** env var, pointing at a directory that *contains* an
   `espeak-ng-data` folder. Both `/opt/homebrew/share` (the system espeak-ng, already installed
   here) and a copy of the wheel's own bundled data work. `lib/tts.ts` must set this on the spawn
   env exactly the way it already sets `HF_HUB_OFFLINE` and `PYTORCH_ENABLE_MPS_FALLBACK`.
   Prefer the wheel's bundled copy over the homebrew one so the app does not depend on a brew
   package the setup script never installed.
2. **Pin `onnxruntime`, and don't use a bare `pip install piper-tts`.** The resolver backtracks
   through multiple ~35 MB onnxruntime wheels; on a throttled connection that is the difference
   between one minute and forty. `onnxruntime==1.29.0` is the current cp312 arm64 build.
3. **`--no-deps` drops numpy.** onnxruntime needs it; install it explicitly rather than relying on
   the transitive pull if the pin above uses `--no-deps`.
4. `EspeakPhonemizer.phonemize(voice, text)` takes **voice first, text second**. Easy to reverse.

## Design

Piper is the **second tenant** of the download mechanism, so build it after MMS phase 3 and let the
second copy prove what's genuinely shared.

### Voice ids

`piper:<key>` — `piper:bg_BG-dimitar-medium`. Multi-speaker voices append the speaker:
`piper:en_US-libritts_r-medium#42`. The key is already the catalogue's primary key and encodes
locale, dataset and quality, so it needs no parallel table.

### Server

- `lib/piper.ts` — `PIPER_VOICES` generated from `voices.json` (key, language family, locale,
  label, quality, MB, license, num_speakers) checked in as a literal; `piperVoiceByKey`,
  `piperVoiceInstalled(key)`. Downloads land in a **plain directory** (`data/piper-voices/<key>/`),
  not the HF cache — Piper resolves models by path, not by repo id, so this does not go through
  `huggingface_hub` at all. That is a real difference from Pocket and MMS: the download is two
  `fetch`es of known URLs with known sizes and md5s from `voices.json`, so it can be done in
  **TypeScript with real progress reporting**, no Python subprocess and no `--cache-only` mode.
- `lib/model-downloads.ts` — extract the in-flight/failure registry shared with
  `lib/mms-languages.ts` here **only if** the second implementation actually repeats it. Given
  Piper downloads in TS and MMS downloads via subprocess, the shared part may be just the registry
  and the tRPC shape. Decide with both in front of you.
- `routes/piper-voices.ts` — `piperVoices.list` / `piperVoices.download`, mirroring `pocket-voices.ts`.
- `scripts/synthesize_piper_tts.py` — the same chunk/progress/done JSON protocol every other
  narrator script emits, so `synthesizeChunkedBackend` in `lib/tts.ts` drives it unchanged.
  Takes `--model <path>`, `--speaker <n>`, and `--length-scale` (= `1 / speed`).
- `lib/tts.ts` — new `piper` engine. **`voiceSupportsSpeed` returns true for it** — the first local
  engine besides Kokoro where the speed slider is live.
- Chunking: unlike MMS, Piper does not need the chunker to supply prosody. It can take whole
  paragraphs. Keep chunks for *progress reporting and resume*, not for pauses.
- `POCKET_ENV_PATH` has a sibling: Piper needs its own venv (`PIPER_ENV_PATH`, default
  `<repo>/.venv-piper`) because it pulls `onnxruntime` and must not disturb the pinned
  `transformers==4.57.6` / torch stack in `.venv`. `scripts/setup.sh` creates it.

### Web

- `lib/voices.ts` — `"piper"` in `VoiceEngine` and `ENGINE_PREFIXES` (**`supportsSpeed: true`**),
  `providerOfVoice` → `"Piper"`, placed in `PROVIDER_ORDER` **above MMS and below Kokoro**.
- `PiperVoiceNotice.tsx` — same shape as `PocketLanguageNotice`, but per *voice* rather than per
  *language*, since Piper's unit of download is a voice. Show quality tier, MB and license on the row.

## Open questions

- **Unit of download.** Pocket and MMS download a *language*; Piper downloads a *voice*, and
  English has 38 of them. The picker's rail is a language axis, so a language with 38 uninstalled
  voices needs a sane presentation — probably "download the recommended one" (the catalogue's
  medium tier) with the rest behind an expander, rather than 38 download buttons.
- **Whether to filter the noncommercial voices.** `docs/tts-licensing.md` says NC voices stay while
  this is noncommercial, so the answer is probably "ship them, label them" — consistent with how
  Pocket's NC voices are already handled.
- **Do we still want MMS at all** if Piper lands first? Yes, but only for its long tail — and that
  argues for building the shared registry with two tenants from the start rather than retrofitting.

## Status

Bulgarian A/B recorded 2026-08-22 against the three existing BG engines, same two sentences
(the picker's preview text, plus a numbers/punctuation probe):

| engine | audio | wall time | speed | sample rate |
|---|---|---|---|---|
| **Piper** `bg_BG-dimitar-medium` | 16.9s | **0.83s** | **~20x realtime** | 22.05 kHz |
| MMS `bul` | 16.2s | 8.4s | ~2x (MPS) | 16 kHz |
| KugelAudio | 15.7s | ~90s | ~0.2x | 24 kHz |
| BG-MLX narrator | **34.8s** | 20s | — | 22.05 kHz |

BG-MLX produced 34.8s of audio for text the others read in ~16s — the known over-generation,
reproduced. Piper Bulgarian is 63 MB, **CC0**, finetuned from the English lessac medium voice.

### 2026-10-05: Bulgarian landed first, as `bg-piper:dimitar`

`feat/bulgarian-engines` ships the one Bulgarian voice through `.venv-piper` and
`scripts/synthesize_piper_tts.py`, set up by `scripts/setup.sh` and fetched with `hf_hub_download`
(pinned revision) rather than the planned TypeScript downloader — the general engine above is still
unbuilt. Two findings change the gotchas list:

- **piper-tts 1.8.0 fixed the broken espeak-ng data path** — no `ESPEAK_DATA_PATH` needed, the
  wheel's bundled data is found on its own.
- **1.8.0 can return phoneme alignments** (`include_alignments=True`; patches the ONNX graph in
  memory, needs the `onnx` package). Wired 2026-10-06 (`scripts/piper_words.py`): word timings for
  every Piper voice, and the general engine inherits them.
