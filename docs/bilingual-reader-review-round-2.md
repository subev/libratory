# Bilingual reader review — round 2

2026-09-28. Branch `feat/bilingual-reader` at `e21d427`, compared with
`f1d0493af11dc88a3d956185536f6db8538ef04f`. Uncommitted documentation was included:
`docs/bilingual-reader-review-handoff.md`, `docs/bilingual-reader-seek-audit.md` and
`tasks/two-languages.md`.

Scope, in the requested order: timing and audio integrity, stale results, cancellation, export
compatibility and regressions. The review was a static reading of the code. No tests, E2E suites,
paid model calls or narration were run, and no code or library data was changed. Spike code under
`packages/server/spikes/` was not reviewed as production code.

## Summary

| # | Severity | Finding |
| --- | --- | --- |
| 1 | High (release gate) | Every ordinary EPUB export now carries a reader layer that the released iPhone reader imports without readable text |
| 2 | Medium | The legacy MP3 seek error also affects the live in-app bilingual reader, not only exports |
| 3 | Medium | Preparation queued for more than 15 minutes is reported as interrupted; monitoring and Stop disappear, and paid word links can be discarded |
| 4 | Low | A recording replaced during a synced export fails the whole export instead of omitting one attachment |
| 5 | Low (unmeasured) | Selection status polling loads and recomputes far more than it displays |

## Findings

### 1. High — ordinary EPUB exports break import in the released iPhone reader

**Where:** `packages/server/src/workers/assemble-document.ts:143-147`. For every original-language
**EPUB** (text) export, `buildTextP2afLayer` and `attachTextReaderLayer` add `p2af/book.json` plus
text resources. The layer is attached whether or not any chapter has a bilingual preparation.

**Why it breaks:** the native repository's own handoff (`~/repos/libratory-app/docs/handoff.md:62-66`)
records that an EPUB containing `p2af/book.json` bypasses plain-EPUB import, and that the released
reader neither decodes a chapter's `text` reference nor extracts that resource. Such a book imports
with chapters whose text is not readable. The fix exists only as uncommitted work in the app's
`feat/bilingual-reader` branch, pending its full check suite.

**Reproduction:**

1. On this branch, open any book in its original-language view — no bilingual preparation needed.
2. Export **EPUB** (text only).
3. Import the file into the current App Store build of the iPhone reader.

Expected: the book imports as a plain EPUB, as the same export did before this branch.
Actual (per the native regression test `StandaloneTextTests`, which failed on
`book.cues(of:) == nil` before its fix): the import takes the read-along path and the text is not
readable.

**Options:** attach the layer only when at least one bilingual attachment exists (which still
leaves those exports affected), or do not release the server change before the native fix ships.
Other EPUB readers are unaffected; they ignore the extra manifest items.

### 2. Medium — the MP3 seek error reaches the live reader, not only exports

**Where:**

- `packages/server/src/lib/bilingual-document.ts:67-68` — the live bilingual document points at
  `/audio/chapter/:id` and `/audio/translation/:id`, which serve the stored recording as is. Older
  books store VBR MP3.
- `packages/server/src/lib/p2af.ts:75,84` — exports accept `.mp3` for the translated recording and
  copy it unchanged; the synced EPUB also copies the primary chapter recording unchanged.

**Why it matters:** the seek audit frames the problem as "normal exports still copy legacy MP3s". The
audit measured 4.5 s (English) and 6.7 s (Bulgarian) early playback through a Blob URL. Playback
over HTTP in `/books/:id/read?with=…` goes through the same browser MP3 demuxer, so the same error
is expected there. This is an inference from the audit, not a separate measurement.

**Reproduction:**

1. Open The Three Sisters at `/books/<id>/read?with=Bulgarian` (live, not an exported file).
2. Click “Сега всички те се отправиха…” near the end of the chapter.

Expected: that sentence plays. Likely actual: the previous sentence (“Наистина…”) plays, as in
`long.epub`.

**Also:** nothing in the bilingual document tells the reader that MP3 narration seeks imprecisely.
Until an explicit conversion path exists, a quality note in “Timing details” would at least explain
why a click lands early. Any conversion must re-hash the converted bytes for narration revisions and
leave the saved library recordings unchanged unless explicitly requested, as the audit already
states.

### 3. Medium — queued work older than 15 minutes is reported as interrupted

**Where:**

- `packages/server/src/routes/bilingual.ts:19` — `busy` is true only for a `queued` or `running`
  job whose `updatedAt` is less than 15 minutes old.
- `packages/server/src/routes/bilingual.ts:29` — `visible` rewrites such a job as `failed` with
  “Preparation was interrupted. Retry explicitly to continue.”
- `updatedAt` is written when the job is queued and is not refreshed while it waits.

Pairing runs as `alignBilingual` in the `index` pool (default concurrency 1), shared with
`indexBook` and `embedChunks`.

**Case A — stranded selection:**

1. Open the Chapters tab in a translation view, select about 69 chapters, open **Bilingual reading**.
2. Choose **Pair missing sentences**.
3. Wait more than 15 minutes while chapters are still waiting in the queue.

Actual:

- Chapters still in the queue show the “interrupted” failure.
- Once no row is busy, polling stops (`packages/web/src/components/BilingualSelection.tsx:16`) and
  **Stop preparation** disappears (`:22`), although `cancelSelection` could still cancel them.
- The same chapters count as missing again (`:23`); another click queues new runs, and the old
  graphile jobs become no-ops.
- The queued jobs that do run later finish without the open panel showing it.

**Case B — paid word links discarded:**

1. On a chapter with current pairs, click **Re-pair sentences**. The job waits in the queue for more
   than 15 minutes behind indexing work.
2. Click **Link words** with a cloud model. The busy check in `queuePreparation`
   (`routes/bilingual.ts:45`) passes, and the link job runs in the `translate` pool against the old
   pairs, spending provider tokens.
3. The pairing job runs and publishes new pairs, which sets `links: null` and `linkJob: null`
   (`packages/server/src/lib/bilingual-store.ts:50`).
4. The link job's next publish fails the pair-revision check and marks itself stale.

Actual: paid links from step 2 are gone. Expected: step 2 refused as “Preparation is already running”.

**Suggested fix:** treat a `queued` job as busy while a graphile job with its `runId` still exists —
the startup sweep (`packages/server/src/workers/sweep.ts`) already performs that lookup — and apply
the 15-minute limit only to `running` jobs, which refresh `updatedAt` as they publish progress.

### 4. Low — a recording replaced during a synced export fails the export

**Where:** `packages/server/src/lib/p2af.ts:74-84`. The translation row, and with it
`variant.audioPath`, is read before `buildBilingualDocument`, which reads the preparation again and
hashes whatever recording is current. The copy then uses the earlier path, and
`validateBilingualExport` (`packages/server/src/lib/readaloud-epub.ts:297`) rejects the revision
mismatch.

**Reproduction:** start a **Synced EPUB** export from the original-language view and, while it runs,
re-narrate a prepared translated chapter so its recording is replaced.

Actual: the whole export fails. Expected: that chapter's bilingual attachment is omitted and logged,
as the other stale cases already are. Nothing corrupt is written; this is a fail-safe that fails too
broadly. The primary chapter recording has the same window between `readaloudChapters` and the
bilingual document build.

### 5. Low (unmeasured) — selection status polling is expensive

**Where:** `packages/server/src/routes/bilingual.ts:80-90` and `summarize` at `:25-27`.

Every 2-second poll while anything is busy:

- Loads full chapter rows, including `rawText` and `sourceBlocks`.
- Loads full `pairs` and `links` JSON: both lane texts, token arrays and every stored raw model
  answer.
- Rebuilds every remaining link prompt for every chapter, only to estimate tokens.

`links.batches` also accumulates raw answers across every retry without a limit. Separately, the
`position` query and `/read/bilingual/:id.json` hash both whole recordings on every call
(`packages/server/src/lib/bilingual-document.ts:39`).

None of this was measured. A status query that selects revisions, counts and job states — and caches
the estimate per pair revision — would avoid it.

## Checked and found sound

- **Run fencing and cancellation.** Every publish checks `runId` and a `queued`/`running` status
  under row locks. A cancelled queued job exits without writing. A link job saves completed batches
  before failing, and a batch in flight at Stop is discarded, as documented.
- **Stale text.** `publishPreparation` rechecks chapter and translation text under `FOR UPDATE`
  before saving; links also check the pair revision. `bilingualReferencesForBook` and
  `buildBilingualDocument` hide a preparation whose text revisions no longer match.
- **Restart recovery.** The sweep deletes locked bilingual jobs and marks rows without a graphile
  job as failed; nothing is replayed automatically.
- **Timing units.** Sync-map word times are absolute (`packages/server/src/lib/sync-map.ts:64-68`),
  matching their use in `packages/server/src/lib/bilingual-timing.ts`.
- **Reopening files.** Opening a second EPUB of the same book in `/open` (for example `long.epub` then
  `long-m4a.epub`) passes through the loading state, which unmounts the previous reader, so its
  manifest and bilingual state do not carry over.
- **Export binding.** Source text is checked against the primary cue or text document, the source
  narration must reference the chapter recording, and revisions are compared with the staged bytes.

## Coverage gaps (not proven defects)

- No automated check that playback lands on the requested sentence in the audio itself. A test of
  the element's reported clock cannot catch finding 2.
- No test for a job waiting in the queue longer than 15 minutes, or for pairing and linking jobs
  overlapping (finding 3).
- No test that an EPUB exported with no bilingual work still imports as a plain EPUB in the native
  reader (finding 1).
- No test for a recording replaced mid-export (finding 4).
