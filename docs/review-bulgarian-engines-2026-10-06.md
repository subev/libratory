# Review: feat/bulgarian-engines (8e11567..HEAD), 2026-10-06

## Summary

`pnpm typecheck` is clean, `pnpm lint` shows only warnings in files the branch did not touch, and the 54 targeted server tests and 1 web test pass. Two real bugs, a handful of leftovers from the MLX/Kugel removal, and two worthwhile simplifications.

- Bug 1 (medium): a paragraph with no speakable characters (`—`, `***`) is now its own chunk and fails the whole chapter on Piper. Reproduced.
- Bug 2 (medium): a book whose stored voice is `bg-mlx:` or `kugel:` loses its audio when Synthesize is started without changing the voice. The old audio is wiped before the retired-voice error is raised.
- parseTtsVoice throwing on retired ids does not break any render or read path. Details under Verification gaps.

## Bugs

### 1. A symbol-only paragraph becomes a chunk that Piper and BgTTS cannot speak (bug, medium)

- `packages/server/src/lib/tts-chunks.ts:15-23` makes a blank line a hard boundary. A paragraph such as `—`, `* * *` or `***` therefore becomes its own chunk.
- Before the branch, `mergeShortUnits` folded such a fragment into a neighbour. Now nothing merges across blank lines.
- Reproduced with `scripts/synthesize_piper_tts.py` on `.venv-piper`, input `"* * *\f—"`: chunk 1 produced 2.1 s of audio, chunk 2 exited with `Error: No audio generated for chunk 2`.
- `scripts/synthesize_piper_tts.py:117` and `scripts/synthesize_bgtts.py:128-129` both raise on empty audio, so the whole chapter fails.
- Unverified: whether Cartesia, ElevenLabs and MMS accept such a chunk. A text-less request is likely a 400 on the cloud engines.
- The normalizer does not remove these (`***` becomes `*`).
- Fix: in `chunkTextForTts`, drop paragraphs without a letter or digit (`.filter((p) => /[\p{L}\p{N}]/u.test(p))`). Alternatively, have the two scripts write silence instead of raising when a chunk has no codes.

### 2. A retired voice survives until after the audio has been wiped (bug, medium)

- `packages/server/src/routes/books.ts:971-1002` (`processSelected`) and `packages/server/src/routes/chapters.ts:100-125` (`queue`) set `audioPath: null, durationMs: null, synthesizedWith: null`, `status: "pending"` and then enqueue.
- The retired-voice error is only raised in the worker, at `parseTtsVoice(voice)` in `tts.ts`. The chapter ends up `failed` with its audio reference gone.
- Scenario: a Bulgarian book with `voice = "bg-mlx:narrator"`. The user opens Synthesize and presses Start without changing the voice, because the modal shows the stored voice (`SynthesizeModal` takes `book.voice`). Every selected done chapter loses its audio reference and fails with "BG-TTS V5 was retired".
- `books.updateSettings` is only called when the user picks a new voice, so it does not catch this.
- Fix: call `parseTtsVoice(book.voice)` at the top of `books.processSelected` and `chapters.queue`, and the equivalent in `variants.queueAudio` and `variants.processSelectedAudio`, before any update. The `books.voice` read is already available in the first two. The UI could also disable Start with the retired message, but the server check is the safeguard.
- Unverified: the variants routes. I did not read how they resolve the lane voice.

### 3. SpeedSlider revives a stale draft (bug, low)

- `packages/web/src/components/SpeedSlider.tsx:25-31,40-41`. The draft is keyed by `base === value`, but after a commit the old draft object stays in state.
- Scenario: value 1.0, drag to 1.2, saved, value is now 1.2 and the draft `{1.2, base 1.0}` is dormant. If `value` later returns to exactly 1.0 from outside the slider (for example a refetch after another save, or an undo), `shown` becomes 1.2 while 1.0 is stored.
- If the save fails or is clamped away, the draft also stays live forever.
- Fix: clear the draft in `commit` after `onChange`, using the mutation's settle callback or a keyed remount, or store the draft only while the pointer is down, `setDraft(null)` in `finishDrag`, and show `clamped` otherwise.
- `onPointerUp` and `onBlur` both call `finishDrag`. A blur that arrives before the refetched `value` lands sends a second identical `onChange`. This is harmless.

### 4. Word timings are not guarded against exceptions (bug, low, hardening)

- `scripts/synthesize.py:256` (`espeak_chunk_words`) and `scripts/synthesize_piper_tts.py:129` (`chunk_words`) run unguarded inside the synthesis loop.
- The phonemizers (`pipeline.g2p(word)`, `voice.phonemize(token)`) are called once per token. A throw there kills the chapter for a feature that is documented as a bonus.
- Fix: wrap the timing call in `try/except Exception` and treat it as `[]`. The Piper script's own header comment says timings are optional.
- Unverified: whether any real token raises. I did not find one.

### 5. Chunks with unreliable timings are re-synthesized on every resume (bug, low, perf)

- `scripts/synthesize_piper_tts.py:59-70` and `synthesize.py:126` require a `.words.json` beside the wav.
- `chunk_words` returns `[]` below MIN_MATCHED or MIN_PLACED, so no file is written and the chunk is spoken again on every resume.
- That is cheap for Piper and costly for Kokoro on a long chapter of poetry or digits. An empty `[]` words file would mark the chunk done, if the loader accepted it.

## Dead code

### D1. `models.capabilities` tRPC procedure has no caller (dead-code)

- `packages/server/src/routes/models.ts:9`.
- `git grep "models\.capabilities\|capabilities\.useQuery" -- packages e2e` returns only e2e mocks (`e2e/scripts/bilingual-preparation.mjs:41`, `e2e/scripts/bilingual-selection.mjs:48`, `e2e/tests/chat-layout.spec.ts:16`).
- The only web consumer, `ModelBundleNotice`, lost its call in this branch.
- `readCapabilities` itself is still used (`marker.ts`, MCP `get_capabilities`), so keep it.
- Fix: delete the procedure and the three mock entries.

### D2. `import wave` in `scripts/synthesize_piper_tts.py:17` is never used (dead-code)

- `git grep -n "wave\b" scripts/synthesize_piper_tts.py` shows only the import.

### D3. `PYTORCH_ENABLE_MPS_FALLBACK: "1"` in the shared spawn env of `synthesizeChunkedBackend` (dead-code, minor)

- `packages/server/src/lib/tts.ts`, in the spawn `env` block.
- Piper, BgTTS, Pocket and say do not use torch-MPS. MMS is the only caller that can need it.
- It is harmless. Keep it only if MMS is meant to use MPS.

### D4. Stale docs

- `docs/uninstall.md:14` says a "KugelAudio 4-bit quant ... 4.6 GB" lives in `~/.cache/libratory-models/`.
- `docs/uninstall.md:43,46` list `models--raditotev--bg-tts-v5-mlx` and `models--nineninesix--nemo-nano-codec-...-MLX`. They are no longer downloaded by the app. Removing them from a cleanup list is harmless, but the "seven repos" count, the 27 GB total and the `rm -rf ~/.cache/libratory-models` step are stale. The new repos (BgTTS, MioCodec, piper-voices) are not listed.
- `AGENTS.md:438` and `scripts/setup.sh:152` still say the Bulgarian narrators bundle is 1.2 GB. `scripts/models.py` now has one `bulgarian` bundle, MMS only, 290 MB (`approxMb: 290`).
- `.env.example:37` mentions `mlx_lm.server` as an example of a custom LLM server. That is fine, it is an LLM server and not TTS.

### D5. `voiceSupportsSpeed` in `tts.ts` is a second copy of `ENGINE_PREFIXES` (dead-code or simplification, see S2).

## Simplifications

### S1. Shared chunk I/O helpers for the Python scripts (worth doing)

- `read_chunks`, `write_chunk_manifest` and `load_existing_chunk` are copied in `synthesize_mms_tts.py`, `synthesize_pocket_tts.py`, `synthesize_say_tts.py`, and now `synthesize_bgtts.py` and `synthesize_piper_tts.py`. That is five copies, and `read_chunks` and `write_chunk_manifest` are identical across all of them.
- `load_existing_chunk` differs only in Piper's extra words-file check, which could be a `needs_words` parameter as `synthesize.py` already does.
- The branch added two of the five. A `scripts/chunk_io.py` imported the way `bg_speech` and `phoneme_words` already are (`sys.path.insert` plus import) would remove about 60 lines. The remaining per-script loop (progress, pause, final concat) is also nearly identical in bgtts, piper and mms, and could become one `synthesize_chunks(chunks, speak, ...)` driver.
- Fix: do the helper extraction. The driver is optional.

### S2. `voiceSupportsSpeed` (`tts.ts:241-244`) duplicates `ENGINE_PREFIXES[*].supportsSpeed` (`voice-catalog.ts:160-167`)

- Both must now be edited when an engine is added, and the branch had to touch both for `bg-piper`.
- Fix: derive it as `ENGINE_PREFIXES.find(e => voice.startsWith(e.prefix))?.supportsSpeed ?? true`, with the same fallback to Kokoro, mirroring the web `voiceSupportsSpeedControl`. Then `parseTtsVoice` is not needed in that path either.

### S3. `NATIVE` logic: `voiceCoversLanguage` and `voiceIsForeignIn` (`voice-catalog.ts:26-37`)

- They are consistent with each other. Nothing to change.

## Verification gaps

- Retired-id render paths. Every server caller of `parseTtsVoice` was checked (`git grep parseTtsVoice -- packages`). They are: input validators (`api-books`, `mcp-server`, `pdf-books`, `books.updateSettings`/`upload`/`retry`, `variants`), the `/preview` route (try/catch, answers 400), `estimateSynthesisCost` (try/catch, returns null), `voiceSupportsSpeed` and `getPreviewTextForVoice` (worker and preview only). None sits on a read or render path for a stored voice. The `synthesize` workers call it inside their try block, so the chapter is marked failed with the named message. The web uses its own prefix-based `engineForVoiceId`, which falls back to `kokoro` for `kugel:` and `narrators` for `bg-mlx:`, and never throws.
- Chapters that were already queued on the removed `tts-mlx` graphile queue are still picked up by a worker (queue names do not gate pickup) and fail with the retired message. Not run.
- Piper: `phoneme_alignments` and `PhonemeAlignment` exist in the installed `.venv-piper` (`piper/voice.py:34,68`). The alignment offsets look right by reading, but audio and timing correctness was not measured.
- `phoneme_words.py` edge cases were reasoned through (punctuation-only tokens, empty `timed`, `written`/`spoken` mismatch, `replace` opcodes). Nothing breaks. The existing tests (`phoneme-words.test.ts`) pass.
- `synthesize.py` parallel lists: `chunk_espeak` is appended wherever the other three lists are, including the split path. They stay parallel.
- Not run: any real Kokoro, BgTTS or cloud synthesis; the e2e suite; the web `SynthesizeModal` against a live server. The cost estimate was compared with `books.processSelected` and `variants.processSelectedAudio` by reading. The status sets and the queueable filter match through the shared constants. Single-chapter estimates ignore in-flight status, which only matters for the display.
- Whether Cartesia and ElevenLabs reject symbol-only chunks (bug 1) is unverified.

## Commands run

- `git diff --stat 8e11567..HEAD`
- `git grep` for `parseTtsVoice`, `voiceSupportsSpeed`, `models.capabilities`, `mlx`/`kugel`/`bg-mlx`/`requiresMlx`/`appleSiliconOnly`, helper names in the scripts, and the exported symbols in the two catalogs
- `pnpm lint` (warnings only, all in untouched files)
- `pnpm typecheck` (clean)
- `pnpm --filter server exec vitest run src/lib/tts src/lib/synthesis-cost src/lib/phoneme-words src/lib/voice-catalog src/lib/model-bundles` (12 files, 54 tests passed)
- `pnpm --filter web exec vitest run src/lib/voices` (passed)
- `.venv-piper/bin/python scripts/synthesize_piper_tts.py` on `"* * *\f—"`, which reproduced bug 1. It wrote only to the session scratchpad.
