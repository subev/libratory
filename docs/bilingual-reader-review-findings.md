# Bilingual reader review findings

2026-09-28. Review of `feat/bilingual-reader` through `c7b3d32`, compared with `f1d0493`, starting
from `docs/bilingual-reader-review-handoff.md`. Read-only review: no files changed, no paid or model
calls. Two scratch scripts were run locally (B1 confirmation, B2 benchmark); the repository test
suite was not rerun.

## Blockers

### B1. Edited or AI-cleaned PDF chapter with a preparation fails the whole synced EPUB export

- `packages/server/src/lib/readaloud-epub.ts:347-348` requires the primary cue document to carry `text`.
- `cuesDocument` includes `text` only when it has blocks (`packages/server/src/lib/reader-doc.ts:263`).
  `buildText` returns plain text without blocks for any PDF chapter with `customText`
  (`reader-doc.ts:219`) and for older extractions whose blocks no longer rebuild the text.
- Confirmed: `buildText` on a PDF chapter with `customText` returns `{"format":"p2af/1","text":"Hello world."}`
  (no `blocks`), so `primaryText` is `undefined` and export throws
  "Bilingual source text differs from chapter text".
- Repro: PDF book → Cleanup (AI) or Edit chapter 1 → narrate → translate → Pair sentences → export
  the original-language synced EPUB. The whole export fails, not just the bilingual attachment.
- Test gap: `workers/prepare-bilingual.test.ts` uses a `kind: "api"` book and stops at
  `buildP2afLayer`; `readaloud-epub.test.ts` hand-builds cue docs that always carry `text`. Nothing
  runs real `buildCues` → `validateBilingualExport`.
- Related: export is all-or-nothing on bilingual attachments. `p2af.ts:76` throws when
  `buildBilingualDocument` returns null, and that recheck compares `variant.updatedAt`
  (`bilingual-document.ts:71`), which translation synthesis bumps per chunk
  (`synthesize-translation.ts:136`). Re-narrating a prepared translation while exporting can fail the
  book's export. Prefer skipping the attachment with a log line over failing the export.

### B2. Sentence alignment blocks the server event loop and cannot be stopped

- `packages/server/src/lib/bilingual-align.ts:46` runs a full N×M dynamic-programming search with up to
  ~12 cosine comparisons of 1024-dim vectors per cell, synchronously in the server process
  (`workers/prepare-bilingual.ts:38`).
- Measured on random vectors: 100×100 → 0.6 s, 200×200 → 2.8 s, 400×400 → 11.8 s (quadratic).
  ~600 sentences per side (a 10k-word chapter) ≈ 26 s; the 2M-cell cap (~1,400²) ≈ 2.5 min.
- During that time HTTP, tRPC, SSE and all other in-process workers stall; Stop cannot interrupt it.
- Fix direction: band the search around the diagonal (vecalign-style) and/or run it in a worker thread.

## Should fix (correctness)

### S1. Voice switch and modal handoff fail in the silence between sentences

- Passage anchors end at the last word's end and start at the first word's start, so inter-sentence
  gaps belong to no passage. `pairAtTime` (`bilingual-format.ts:156`) returns null there and
  `switchNarration` (`:176`) returns null except at ms 0.
- Repro: play the source, pause just after a sentence ends, press the other language's voice button →
  "No timed counterpart here" (`components/reader/BilingualReader.tsx:175`).
- The same gap makes "Open bilingual reader" from the chapter modal land at 0 ms
  (`routes/bilingual.ts:39`), and the active-passage highlight flickers off between sentences.
- Fix: fall back to the nearest preceding passage.

### S2. Space needs two presses after a click-to-listen

- Clicking a word on the current side sets `landing.current.play = true`; only `onLoadedMetadata`
  clears it, and that does not fire for a same-element seek.
- After playback stops by other means (chapter end, media keys, audio error), the next Space hits the
  `landing.current.play` branch (`BilingualReader.tsx:67`), pauses an already-paused element and does
  nothing.
- Fix: clear the flag once `play()` is issued on the same element.

### S3. RTL direction comes from content, not the lane language

- `dir="auto"` (`BilingualReader.tsx:287`, also tooltip lines `:296-297`) takes direction from the
  first strong character of the paragraph group.
- Repro: a Hebrew paragraph starting with a Latin name or acronym ("CNN", "iPhone") renders LTR, with
  punctuation and mixed runs misplaced.
- Fix: derive `dir` from the lane language.

### S4. Unset book language is treated as English

- `languageCode(null)` returns `"en"` (`workers/prepare-bilingual.ts:27`), so a book without
  `books.language` gets English sentence/word segmentation and `lang="en"` on its lane — for
  Bulgarian that also means Russian letterforms.
- Fix: refuse to pair, or use `und`, until the language is known.

### S5. One unlocatable chunk drops the whole narration lane

- `bilingual-document.ts:37` returns null narration if any sync-map chunk cannot be located in the
  text. It doubles as a staleness guard, but the single-language reader tolerates per-cue misses.
- Verify against real Kokoro, Cartesia and ElevenLabs sync maps before relying on it.

## Later improvements

- Long-chapter rendering: every word in both lanes is a `<button>`, all re-rendered on each 100 ms
  time tick (`BilingualReader.tsx:62`, `renderPair` at `:181`) with fresh handler objects. ~20k
  buttons at 10k words. Unprofiled — measure on a real chapter.
- `/read/bilingual` and `bilingual.position` re-hash both full audio files per request
  (`bilingual-document.ts:39`); every manifest request detoasts each prepared chapter's full `pairs`
  JSON to read two revisions (`:18`). Store revisions in columns; cache hashes by mtime/size.
- `busy` uses a 15-minute staleness window (`routes/bilingual.ts:18`): a pair job queued behind
  indexing in the single-slot index pool is shown as "interrupted". Fenced by runId, but misleading.
- In default bilingual mode, a failing bilingual document shows a status screen (`pages/Reader.tsx:137`)
  instead of falling back to single-language reading.
- `links.batches` retains every raw answer across retries without bound.
- Grapheme validation uses the runtime ICU; Node-produced documents may be rejected by a browser/iOS
  with different Unicode tables (mainly Indic scripts). Check with the native reader later.

## Test gaps to close

- Preparation tests mock LLM and embeddings with one-sentence fixtures: no evidence on aligner cost or
  real sync maps.
- No PDF chapter, no edited/cleaned text, no real `buildCues` feeding the export validation (B1).
- No paused position in inter-sentence silence (S1), no Space after natural playback end (S2).
- The RTL browser check cannot catch S3 unless a Hebrew paragraph starts with Latin text.
