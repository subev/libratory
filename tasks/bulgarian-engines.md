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
- BgTTS sometimes stops a syllable early: it emits end-of-speech before the last letters. Example:
  Frankenstein's first letter, "…по-пламенни и по-ярки." is spoken "…по-яр" (chunk 7, seed 562,
  125 frames; seeds 1–4 give 128–135 frames and say the whole word). It is in the generated audio,
  not the timings, and predates word timing, because generation is seeded per chunk and runs before
  the attention pass. Attention can't detect it: in 39 of 90 corpus readings the final frames stop
  1–3 letters short of the end even when complete, and the clipped one stops 1 short. A check needs
  another signal (an ASR pass on the last word, or comparing two seeds' lengths), and a
  re-synthesis would need a per-chunk seed or a "regenerate this chunk" action.

## Polish if it stays

- BgTTS in the Docker image (~1.5 GB). The desktop app builds it on request from the voice picker
  since 2026-10-07 (`scripts/install_bgtts.sh`); Piper ships in both.
- `9 ч.` (hour without minutes) is not expanded by the normalizer.
