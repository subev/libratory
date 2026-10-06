# Retire the BG-TTS V5 MLX narrator, and let chunks follow paragraphs

BgTTS-38M V2 (`bg-bgtts:`) was judged better than BG-TTS V5 (`bg-mlx:narrator`) on 2026-10-06.
Most of what was built around V5 exists to work around one property of it, and some of that
workaround is shared by every engine.

## What V5 cost, traced

The model emits ~20–24 s of audio per call whatever the text length: its end-of-speech token is
sampled at a learned decode step, not when the text runs out. Short input comes back padded with
repetition and mumble.

| when | commit | what it added |
| --- | --- | --- |
| 2026-04-04 | db9a7af | the engine, `synthesize_bg_tts_mlx.py`, `nanocodec-mlx` |
| 2026-06-06 | e26dbdb | **`NARRATOR_CHUNKS`**: pack toward 285 chars, cap 320, balance chunks so none is short (`balancePartition`, `minMaxCapacity`, `chunksNeeded`, `packToCapacity`) |
| 2026-06-06 | e26dbdb | `chunkTextForTts` **collapses every newline** "so packing can merge across them" |
| 2026-08-24 | 76022fa | `SENTENCE_CHUNKS` for engines without the quirk — but the newline collapse stayed shared |
| 2026-08-26 | e90a08e | `mlx==0.32.0` override: nanocodec-mlx pins 0.29.2 |
| later | — | `bulgarian-narrator` model bundle (957 MB) + its picker notice, `requiresMlx` on the voice |

The pack mode is also the **default** of `chunkTextForTts` and `synthesizeChunkedBackend`, so
Cartesia, ElevenLabs, Pocket and KugelAudio all inherited V5's 285/320 packing without needing it,
and every seam between chunks restarts an API voice's tone.

Not V5's alone, and staying while KugelAudio stays: `runExclusiveMlxSynthesis`, the `tts-mlx`
graphile queue, `requiresMlx` / `capabilities.mlx`, `mlx`, `mlx-lm`, `mlx-audio` and the
`transformers` / `huggingface_hub` / `numpy` overrides that `mlx-audio`'s declared constraints force.

## The missing pause after a title is the newline collapse

`39 Дяволът и неговата баба⏎⏎Имало едно време…` reaches BgTTS as
`39 Дяволът и неговата баба Имало едно време…` — one sentence, so no pause. The songbook chapter
(`СВЕКЪРВА И СНАХА⏎⏎1055. ГЛЕДАМ ТЕ…⏎⏎Мари, Калинко-Малинко,⏎що ме…`) arrives as one run. Verified by
running the chunker on both stored texts. Not the model and not the normalizer: `cleanText` keeps
`\n\n`; the first line of `chunkTextForTts` throws it away.

## Plan

1. **Paragraphs are hard boundaries in sentence mode** (BgTTS, Piper, MMS, `say`). Split on blank
   lines first; never merge a chunk across one. A title becomes its own chunk, so it gets the
   250 ms gap and its own intonation. Pack mode keeps collapsing until step 2, because short
   chunks are exactly what V5 cannot take. Existing audio is untouched; a chapter mid-synthesis
   re-generates the chunks whose text changed (`dropStaleChunks`).
   Single newlines (verse lines) are a separate question: in this library they are almost always
   verse or API text, but a hard-wrapped source would read every wrap as a pause. Listen to the
   songbook with step 1 first, then decide.
2. **Retire V5.**
   - Delete `synthesize_bg_tts_mlx.py`, the `bg-mlx` engine in `lib/tts.ts`, its catalog entry,
     the `bulgarian-narrator` bundle and its notice, `tts-bg-mlx-dispatch.test.ts`; MLX queue for
     `kugel` only.
   - `pyproject.toml`: drop `nanocodec-mlx`, its git source and the `mlx==0.32.0` override.
     Probed in a scratch copy: the relock removes exactly `nanocodec-mlx` and `mlx` stays 0.32.0.
   - Stored ids stay readable: 148 chapters (60 original, 88 variant) were narrated by it and keep
     their audio and label. Synthesizing with it fails by name, pointing at BgTTS. One book has it
     as its voice — decide whether to move it to a BgTTS voice.
   - Tests that use `bg-mlx:narrator` as a sample voice switch to `kugel:default` or `bg-bgtts:`.
   - Docs: README voice table and requirements line, AGENTS (engines, chunking, pools), read-along
     docs, `tasks/` references. `docs/uninstall.md` keeps the cache path.
   - Disk: 957 MB model + 401 MB codec in the HF cache, removable once nothing names them.
3. **Pack mode goes; API engines chunk by paragraph.** With V5 gone nothing needs fixed-length
   chunks. Cartesia and ElevenLabs move to whole paragraphs (split only past the provider's request
   size), which is fewer seams than V5's packing; Pocket and KugelAudio to sentence mode. `balancePartition` and its three helpers (~70
   lines) are deleted. Re-listen to one Cartesia and one ElevenLabs chapter before keeping it.
4. **Separate decision, not proposed here: KugelAudio.** It is the last MLX engine. Probed: a lock
   without it drops `mlx`, `mlx-lm`, `mlx-audio`, `mlx-metal`, `miniaudio`, `sounddevice`, and the
   three overrides become plain pins (`sentence-transformers` 6.0 → 5.7 would need a check). It
   would also take the MLX lock, the `tts-mlx` queue, `requiresMlx` and setup's 17 GB quantize step.
   Worth an A/B against BgTTS before deciding.
