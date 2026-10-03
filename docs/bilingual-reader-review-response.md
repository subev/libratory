# Response to the bilingual reader review

2026-09-28. Addresses `bilingual-reader-review-findings.md` against `c7b3d32`, together with the
separate user-reported word-link failure. The original findings file is unchanged. Fixes are in the
follow-up checkpoint on `feat/bilingual-reader`; no paid calls, new recordings or downloads were made.

| Finding | Resolution and evidence |
| --- | --- |
| B1 — edited PDF export fails | Fixed: `cuesDocument` carries exact text and located ranges even without layout blocks. New integration tests create PDF-backed chapters with edited and legacy unstructured text, run real `buildCues` → `buildP2afLayer` → `buildReadaloudEpub`, and inspect the archived bilingual document. PDF geometry is a cached fixture; audio bytes are synthetic. |
| B1 — concurrent attachment changes fail export | A changed optional document is omitted with a book log entry, retaining primary cues and no dangling bilingual references. Timing-file changes detected during hashing now produce that same unavailable snapshot result. Corrupt content and failed staged recording identity checks remain errors; integrity checks are not bypassed. |
| B2 — alignment stalls server / Stop | Fixed with cooperative scheduling rather than changing alignment scoring: the DP yields after roughly 8 ms of work and checks job ownership/cancellation at most every 250 ms while searching. A timer-driven regression verifies interruption. A 400×400, 1024-dimensional synthetic run took 11.5 seconds, with 474 timer ticks and a longest timer interval of 28 ms. Total CPU and memory complexity remain quadratic; banding/offloading can be evaluated later. |
| S1 — silence loses passage | Passage lookup retains the preceding timed passage through a gap. It does not extend that fallback across an untimed passage or past the recording. Voice switching and modal handoff share this lookup. Tests cover inter-sentence gaps, trailing silence, missing timing and lack of invented word highlights. |
| S2 — Space needs two presses | Same-element seeks consume the pending-play flag when issuing play. The browser regression clicks a word, reaches natural playback end, and restarts with one Space press. |
| S3 — Hebrew with a Latin opening | Paragraphs and tooltips get direction from the lane locale, computed once per language. Uses the runtime's `Intl.Locale` direction API (method or older getter); unknown tags or unsupported runtimes retain `auto`. Browser check prepends “CNN” to a Hebrew paragraph and verifies RTL. |
| S4 — unset source language | Preparation uses `und` for an unset source language. Added missing translation-name mappings, including Hebrew and Arabic, so the producer does not erase a known target language before rendering. Tests cover unset source and a translation selected as Hebrew. |
| S5 — one missing chunk drops voice | Located chunks retain their anchors; an entirely unlocatable map has no narration. Partially located maps carry a quality note and unavailable edges for unmatched passages. A three-passage regression checks the missing middle while retaining the first and last. Read-only inspection found 70 unlocatable chunks among 1,997 chunks in 30 local/other recordings, and none among 41 chunks in six Cartesia recordings. This comparison is against current text and does not establish whether differences came from later edits or provider output. No ElevenLabs recordings were available in that audit, so no provider-wide claim is made. |

## Word-link failure reported separately

The saved response contained both harmless unlinked declarations using target IDs on the left and
one real target-to-target link in p6. Numeric unlinked declarations are ignored because they store
no references. Actual links remain strictly bound to their sentence and lane. A valid sentence
survives another sentence's invalid answer; the job fails once and explicit retry requests only
missing groups. Unassignable lines, unknown pair IDs and truncated responses still reject the batch.
Local replay preserved nine of ten groups and rejected p6. Existing successful results were untouched.

## Validation and limits

- `pnpm lint` and `pnpm typecheck` pass; lint warnings remain.
- `pnpm test --maxWorkers=2`: 953 server, 151 web and 38 desktop tests pass (1,142 total).
- `node e2e/scripts/bilingual-reader.mjs` passes for saved English–Bulgarian, English–Hebrew and
  Bulgarian–German examples, including the new playback/RTL regressions and existing alternation.
- Model requests remain mocked in preparation tests. These fixes do not establish mapping accuracy
  on a new book, eliminate all audio snapshot races, or demonstrate native bilingual compatibility.

The review's later improvements remain open: whole-chapter rendering/tab stops, hash caching and
revision columns, truthful long-queued-job state, default-mode fallback, bounded raw diagnostics,
and Unicode-version compatibility. The optional attachment can still be refused for an actual
packaged-audio hash mismatch; exporting inconsistent timing is not an acceptable fallback.

## Simplification review

The original `bilingual-reader-simplify-findings.md` is preserved. Applied the small changes with
clear benefits alongside the correctness fixes:

- **Synchronous validation.** `readBilingualDocument` no longer wraps synchronous hashes in a
  promise. A worker regression first reproduced publication of malformed tokens followed by an
  unhandled rejection; now the job fails before saving pairs. Callers no longer need an extra await.
- **Cheap cancellation checks.** Alignment checks only the job's run ID and running status. It no
  longer locks text owners, loads chapter/artifact payloads or rewrites job state four times per
  second. Publication retains its locked text/revision checks. Tests cover cancellation and a
  different run ID; ordinary progress updates still timestamp the job during embedding.
- **Shared streaming hashes.** `fileSha256` serves OCR fingerprints, live narration and staged EPUB
  validation. Export no longer buffers an entire recording merely to hash it. This adds no digest
  cache, so replacing a recording still causes its bytes to be checked.
- **One passage lookup.** Passage anchors are indexed lazily per immutable timing array in a
  WeakMap. Playback, switching, click-to-listen and sentence sequencing use the same lookup;
  callers no longer supply an optional second index. Replacing the timing array rebuilds it.
- **Shared boundaries.** Grapheme boundary construction and token-in-range selection have single
  helpers. The bilingual player now subscribes to the shared speed preference as other players do.

Two proposed removals were deliberately not adopted:

- The early alignment size cap avoids embedding a chapter that the aligner will reject. The
  aligner's own cap also protects direct callers.
- Cue documents now retain the exact `buildText(chapter)` result even without layout blocks.
  Comparing the bilingual source against that packaged text checks what a consumer receives.
  Adding another text copy on the layer entry is unnecessary here. The PDF integration regressions
  cover edited and legacy unstructured chapters through the actual export, with blocks still absent.

The rest is deferred, not considered fixed. In order for a separate performance pass:

1. Profile a long real chapter's preparation, reader rendering, status polling and export.
2. Evaluate banded alignment against the current full-search results, including large omissions
   and insertions; cooperative yielding fixes responsiveness but not quadratic work. A worker
   thread alone also does not reduce that work.
3. Reduce per-tick rendering/scans and status-poll work where the profile warrants it; then consider
   revision columns and a bounded hash cache with explicit file-replacement invalidation.
4. Consolidate parser traversal, job settling, chapter selection and speed controls when touching
   those paths. Preserve run fencing, strict lane addressing, partial-result behavior and explicit
   retry. Cosmetic status/default/constant changes do not need to hold up this checkpoint.

Do not fold the time-zero switch rule into a general “before first passage” fallback without a
missing-leading-timing test. Direction on the wire and a shared language table can be decided with
the native consumer; neither needs a format change in this checkpoint.
