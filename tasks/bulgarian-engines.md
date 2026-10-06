# Bulgarian engines trial: BgTTS-38M V2, Piper, and the Bulgarian normalizer

Branch `feat/bulgarian-engines`, started 2026-10-05 from a TTS digest. Built for listening, not yet
polished; decide what stays after an A/B on a real book.

## What is on the branch

- `bg-bgtts:female|male|male2` — `beleata74/BgTTS-38M-V2` (Apache-2.0), CPU, `.venv-bgtts`, opt-in
  in setup (`pnpm run setup --bgtts`, ~1.5 GB: torch 2.9.1 + MioCodec ~500 MB + WavLM base+ 360 MB).
  Measured ~11x realtime on this Mac (the card claims 3.3x on an i3). No published WER/MOS.
- `bg-piper:dimitar` — Piper 1.8.0 + `bg_BG-dimitar-medium` (CC0), ~20x realtime, speed works, and
  word timings: 120 of 120 real Bulgarian chunks (Grimm prose, songbook verse) placed.
- `scripts/bg_speech.py` over the vendored `bg_text_normalizer` — applied by every Bulgarian-only
  engine (MMS, Piper, BgTTS; BG-MLX until it was retired). On a number-heavy passage BgTTS read 14.0 s raw vs 22.7 s
  normalized: it was silently skipping digits.
- BgTTS was chosen over BG-TTS V5 on 2026-10-06; V5 and KugelAudio were removed the same day,
  and with them MLX and the narrator's fixed-length chunk packing.

## Listen for

- BgTTS's 18 s per-utterance ceiling: chunks are `SENTENCE_CHUNKS` and the script re-splits at the
  model's 250 characters after expansion, then decodes the pieces as one code stream.
- Abbreviations before a capitalised word: `bg_speech` keeps a sentence-final dot only after
  abbreviations that follow their noun (`г.`, `лв.`, `др.`); `гр. София`, `проф. Петров` are never
  read as sentence ends.

## Polish if it stays

- Bundle UI: neither engine is in `scripts/models.py`. A missing venv disables the row with the
  setup command (`requiresEngine`), not a download button. The Dockerfile and the desktop app's first
  run build neither venv.
- `9 ч.` (hour without minutes) is not expanded by the normalizer.
- Word timings for BgTTS: an autoregressive model with no durations; would need a forced aligner.
