# Bulgarian engines trial: BgTTS-38M V2, Piper, and the Bulgarian normalizer

Branch `feat/bulgarian-engines`, started 2026-10-05 from a TTS digest. Built for listening, not yet
polished; decide what stays after an A/B on a real book.

## What is on the branch

- `bg-bgtts:female|male|male2` — `beleata74/BgTTS-38M-V2` (Apache-2.0), CPU, `.venv-bgtts`, opt-in
  in setup (`pnpm run setup --bgtts`, ~1.5 GB: torch 2.9.1 + MioCodec ~500 MB + WavLM base+ 360 MB).
  Measured ~11x realtime on this Mac (the card claims 3.3x on an i3). No published WER/MOS.
- `bg-piper:dimitar` — Piper 1.8.0 + `bg_BG-dimitar-medium` (CC0), ~20x realtime, speed works.
- `scripts/bg_speech.py` over the vendored `bg_text_normalizer` — applied by every Bulgarian-only
  engine (BG-MLX, MMS, Piper, BgTTS). On a number-heavy passage BgTTS read 14.0 s raw vs 22.7 s
  normalized: it was silently skipping digits.

## Listen for

- **BG-MLX on number-heavy chunks.** Expansion roughly doubles a chunk's length, and the narrator
  emits ~20-24 s whatever the text (see `NARRATOR_CHUNKS`). A 170-character probe came out 20.8 s —
  at the ceiling, so its end may be clipped. If so, normalize before chunking (it would have to move
  to TS, or the chunker learn the expanded length) or exclude BG-MLX.
- BgTTS's 18 s per-utterance ceiling: chunks are `SENTENCE_CHUNKS` and the script re-splits at the
  model's 250 characters after expansion, then decodes the pieces as one code stream.
- Abbreviations before a capitalised word: `bg_speech` keeps a sentence-final dot only after
  abbreviations that follow their noun (`г.`, `лв.`, `др.`); `гр. София`, `проф. Петров` are never
  read as sentence ends.

## Polish if it stays

- Bundle UI: neither engine is in `scripts/models.py`. A missing venv disables the row with the
  setup command (`requiresEngine`), not a download button. The Dockerfile and the desktop app's first
  run build neither venv.
- Piper word timings from `include_alignments` (see `tasks/piper-voices.md`).
- BgTTS voice cloning (3-10 s reference) — the Pocket cloner's UI is the template.
- `9 ч.` (hour without minutes) is not expanded by the normalizer.
- `voiceHasWordTiming` stays false for both; read-along is chunk level.
