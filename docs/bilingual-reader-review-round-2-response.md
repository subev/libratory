# Round 2 review response — 2026-09-28

The [review report](bilingual-reader-review-round-2.md) was read and checked against the code.
The user confirmed that the M4A comparison resolves the reported late-chapter seek mismatch.

| Finding | Disposition |
| --- | --- |
| 1. Released native reader cannot consume standalone primary text | Confirmed release gate. Shared import fix exists in the native branch but remains uncommitted pending its required full simulator suite. Do not release the new text-export behavior before a compatible native reader is available. |
| 2. Legacy MP3 affects live reading as well as exports | Addressed with an explicit conversion action that changes the active recording paths used by both live endpoints and future exports. Original MP3 files remain intact. Existing exported files still need re-exporting. |
| 3. Work waiting over 15 minutes appears failed | Fixed. Status and mutual exclusion use persisted job states; elapsed time alone cannot hide Stop or permit conflicting work. |
| 4. Recording replacement can fail the whole export | Retained fail-safe behavior. A mismatch between staged audio and its declared revision must fail before archiving; silently accepting it would be worse. Optional-only omission can be improved later, but a primary-recording mismatch also threatens primary cues, so blanket omission is not a safe fix. No automatic retry was added. |
| 5. Polling loads/recomputes too much | Measured current selection: 69 chapters, one prepared, 35/17/16 ms and a 24,087-byte response. This does not establish the cost of a fully prepared book. Defer broad caching/query refactoring until that case is measured; large internal JSON and repeated estimates remain a profiling target. |

## Job-state fix

A queued job can legitimately wait behind indexing work. A running job can be slow without being
dead. Both remain visible and exclusive until the worker, explicit cancellation or the existing
startup recovery sweep persists a terminal status. Stop continues to fence publication immediately.
This also avoids checking Graphile existence during the short interval between saving queued state
and submitting the job. No new job lookup, heartbeat or retry mechanism was introduced.

Four regressions failed before the fix and pass afterward: queued/running pairs/links aged one
hour still appear busy in both single-chapter and selection status, reject competing work, skip
bulk requeue, and remain cancellable without losing saved pairs. The existing enqueue-failure and
restart-recovery tests continue covering orphan recovery.

## Explicit legacy conversion

In the chapter translation's **Bilingual reading** section, old recordings expose
**Convert recordings for accurate seeking**. This is an explicit local action, not new narration
and not a side effect of opening a reader. It creates M4A copies with the existing encoder and
copies the existing sync maps. The original files, text, sentence pairs and word links are retained.
New active paths are published together only after locked text/status/path checks and original
recording/timing hashes still match. A failed or stale conversion removes its unpublished copies.
The chapter log and button show progress; errors surface without retries.

The live document hashes the newly active bytes; normal EPUB export copies and validates those
same bytes. No export-only rewrite or guessed timeline offset is used. Old MP3 documents also
explain their seek limitation in Timing details. This remains a per-chapter action; automatic
conversion of an entire library is not implemented or authorized.

Six integration regressions cover both-lane success, unchanged maps/links/originals, no automatic
conversion on reads, repeat no-op, partial encoder failure, and concurrent text/audio/timing or
narration changes. The focused browser preparation check covers the explicit action and refresh.

A disposable copy of The Three Sisters passed the actual production conversion in 9.04 seconds,
new live-document hashes, unchanged anchors/pairs and production EPUB export validation. Original
library rows were compared unchanged, and the disposable book was deleted. Local artifacts:
`packages/server/data/tmp/bilingual-acceptance/long-converted.epub`, `long-converted.json`,
`converted-source.m4a`, `converted-target.m4a`, and `convert-audio.mts` (creates a disposable book;
do not run casually).

## Acoustic verification

`node e2e/scripts/audio-seek.mjs <recording> <seconds...>` captures browser playback and matches
it against a sequential FFmpeg decode. It fails when seeking lands over 80 ms from the reported
clock, and refuses to make a timing claim for a weak waveform match. It is a focused opt-in
browser check, requiring existing Playwright and FFmpeg, with no model download or provider calls.
The browser capture buffer contributes 256 ms, which is subtracted from the measurement.

The original Bulgarian MP3 fails at 1657.499 s with a measured 6705 ms offset and 0.997 waveform
correlation. Production-converted M4A passes at 800 s and 1657.499 s; English passes at 600 s and
1290.609 s. All four errors were under 2 ms in this run. These results verify media seeking, not
the accuracy of estimated sentence boundaries. No provider word timestamps were added.

Checkpoint validation: `pnpm lint`, `pnpm typecheck` and `pnpm test --maxWorkers=2` pass
(**1,156 tests**: 967 server, 151 web, 38 desktop). The focused preparation browser check passes.
No full E2E or native simulator suite was run in this follow-up.

Next: complete the native import release gate and its chosen bilingual interface scope, then
whole-book audio acceptance, assistant/MCP parity (including the explicit conversion operation),
and spike cleanup. No release, push or merge is implied by these fixes.
