# Bilingual reader simplify findings

2026-09-28. Quality pass (reuse, simplification, efficiency, altitude) over production code in
`f1d0493..HEAD` plus the uncommitted working-tree edits present at review time. Spikes, docs and tests
are out of scope. Report only — nothing was applied, because another agent is editing the branch.
Correctness bugs are in `docs/bilingual-reader-review-findings.md`; one found in passing is listed
first because it is cheap and real.

## Noticed in passing (correctness)

- `packages/server/src/workers/prepare-bilingual.ts:46` — `readBilingualDocument(...)` is async and not
  awaited. The format validation of freshly built pairs does not gate publication, and a failure
  becomes an unhandled rejection instead of a failed job. Await it (or make it sync, see R/S below).

## Reuse

1. **Streaming file SHA-256 already exists.** `bilingual-document.ts:38-39` hand-rolls
   `createReadStream` + `createHash`; `readaloud-epub.ts:352-353` does it again with `readFile`
   (whole file in memory). `pdfFingerprint` in `lib/ocr-line-cache.ts:30` is the same streaming hash —
   promote it to a neutrally named shared helper (e.g. `fileSha256`) and use it in all three.
2. **Grapheme boundary set is built twice.** `bilingual-format.ts` (`parseBilingualDocument`) and
   `bilingual-document.ts` (`narration`) both build `new Set([len, ...Intl.Segmenter(grapheme)])`.
   Export one `graphemeBoundaries(text)` from `bilingual-format.ts`.
3. **"Token inside range" is written three times.** `bilingual-format.ts` has `inside()`;
   `bilingual-links.ts` repeats `t.range[0] >= range[0] && t.range[1] <= range[1]` in `linkPrompt` and
   in `parseWordLinks`. Export a `tokensIn(lane, range)` next to `inside()`.
4. **Job-state patches are copy-pasted.** `{ ...job, status: "failed", error, updatedAt: new Date().toISOString() }`
   appears in `publishPreparation`, `failPreparation` (`bilingual-store.ts`) and `cancel`
   (`routes/bilingual.ts`), each with its own `SELECT … FOR UPDATE` + runId/status check. One
   `settleJob(tx, variantId, stage, runId | null, patch)` in `bilingual-store.ts` covers all three.
5. **Stale-running window.** `routes/bilingual.ts:18` inlines `15 * 60_000`; `routes/chapters.ts:20`,
   `routes/variants.ts:24` and `routes/books.ts:38` each name it (`STALE_RUNNING_MS`). Follow the
   named-constant convention at least; a shared constant would be better.
6. **Reader chapter choice is duplicated.** `pages/Reader.tsx` `ReaderFor` (~line 105) and
   `SingleReader` (~line 159) each compute "requested chapter ?? first narrated ?? first". Compute it
   once in `ReaderFor` and pass the chapter down, so the bilingual refs and the single reader cannot
   pick different chapters.
7. **Player controls are a third copy.** `BilingualReader.tsx:~240` re-implements the speed `<select>`,
   play/pause button and elapsed/total readout already in `Reader.tsx:~330-345` (and a speed select in
   `ChapterModal.tsx:1071`). A small shared `SpeedSelect` (and possibly the time readout) keeps
   styling and `saveSpeed`/`subscribeSpeed` behaviour consistent — the bilingual copy does not
   subscribe to speed changes made elsewhere.

## Simplification

1. **Two lookups for one passage anchor.** `passageAnchor` (linear `find`) and `passageIndex` (Map)
   answer the same question; `pairAtTime`/`switchNarration` take an optional index and branch on it,
   and `sentenceSequence`, `sentenceStartIndex`, `listenPosition` use the linear one. Build the index
   once per document (or cache it by document in a `WeakMap`) and drop the optional parameter and
   the linear path.
2. **`readBilingualDocument` need not be async.** `textRevision` is synchronous; the
   `Promise.all` over two sync calls only adds an `await` to every caller (and made the missing
   `await` above easy to write). Make it sync.
3. **Size cap checked twice.** `prepare-bilingual.ts:29` and `bilingual-align.ts` (`alignVectors`)
   both enforce `src.length * tgt.length > 2_000_000`. Keep it in `alignVectors`.
4. **Word-link parsing parses twice.** New `parseWordLinkBatch` (`bilingual-links.ts:79`) splits the
   answer by pair, re-joins each group and calls `parseWordLinks`, which splits and regex-matches the
   same lines again. Let one parser walk lines once, collecting per-pair links and per-pair errors;
   `parseWordLinks` then becomes the "all pairs must succeed" view of that result.
5. **Status route's empty result.** `routes/bilingual.ts` `status` returns an 11-field literal of zeros
   and nulls on the early path, duplicating the full shape below it. Build the result from one
   default object so a new field cannot be missed on one path.
6. **Revision checks exist in two dialects.** `bilingualReferencesForBook` re-derives "current" with
   SQL `coalesce(customText, cleanText, rawText, '')` + JSON path reads + JS `trim()`/hash, while
   `currentPreparation` uses `chapterText()` + `matchesTexts`. One definition of "current" (see
   Altitude 3) removes the chance of the two drifting.

## Efficiency

1. **Heartbeat during alignment is a full publish.** `alignVectors(..., () => publish({ job: {} }))`
   (`prepare-bilingual.ts:38`) runs `publishPreparation` every ~250 ms: a transaction that locks and
   loads the whole chapter and translation text, compares them, and rewrites the job JSON. A cheap
   `SELECT link/pair_job->>'runId', ->>'status'` is enough to decide "keep running"; the text check
   only matters at publication.
2. **Audio re-hashed on every request.** `/read/bilingual/:id.json` and `bilingual.position` hash both
   whole recordings each call (`bilingual-document.ts:38-39`); export hashes each again in
   `buildBilingualDocument` and a third time in `validateBilingualExport` (via `readFile`, loading the
   file into memory). A chapter with two translations hashes its original twice. Cache the digest by
   `(path, size, mtimeMs)`; stream in validation.
3. **Manifest detoasts every preparation.** `bilingualReferencesForBook` reads
   `pairs->'source'->>'textRevision'` from the full `pairs` JSON (texts + tokens) for every prepared
   chapter on every manifest request. Store `source_revision`/`target_revision` as columns.
4. **Status polling recomputes everything.** `bilingual.status` (polled every 2 s while busy) loads full
   texts and pairs, rehashes both texts, and runs `linkBatches` + `linkPrompt` per batch, where
   `linkPrompt` filters all lane tokens per pair (O(pairs × tokens)). Compute the token/batch estimate
   once when pairs are published and store it; while busy, return job progress only.
5. **Extra queries in export.** `p2af.ts` selects the variant row per reference, then
   `buildBilingualDocument` loads the same context twice more. Pass the already-loaded rows in, or
   batch the variant select for the chapter.
6. **Per-tick linear scans on the client.** `tokenAtTime` scans all word anchors then all tokens, and
   `pairAtTime` scans all pairs, on every 100 ms tick. Anchors are time-ordered: precompute sorted
   start arrays (per lane) and binary-search; map anchor → token once.
7. **Whole chapter re-renders per tick.** `renderPair` (`BilingualReader.tsx:~181`) rebuilds every word
   button in both lanes each tick, with fresh `meaning.handlers(...)` objects. Memoise a paragraph
   component keyed on the few values that affect it (active pair/token/counterpart/selection in that
   paragraph) and use one delegated handler reading `data-token`, so a tick re-renders one or two
   paragraphs instead of the chapter.
8. **`sentenceStartIndex` is O(pairs × anchors) per click** via linear `passageAnchor`; resolved by
   Simplification 1.

## Altitude

1. **Alignment yielding is a bandaid over a quadratic search.** The new `setImmediate` every 8 ms
   (`bilingual-align.ts:51-58`) keeps the server responsive but still does all N×M×~12 cosines
   (~26 s for 600 sentences per side, measured at ~11.8 s for 400). The root fix is a banded search
   around the diagonal (vecalign-style, or a coarse pass then a band), which also makes the
   cancellation hook and the 2M cap mostly unnecessary. Alternatively move it to a worker thread
   and keep the event loop out of it entirely.
2. **Export validation checks the wrong source of truth.** `validateBilingualExport`
   (`readaloud-epub.ts:347`) compares against the cue document's optional `text`, which is present
   only when blocks exist — the cause of blocker B1. Compare against the chapter's actual text
   (`buildText(chapter).text` / `chapterText(chapter).trim()`, carried on the layer entry) rather than
   making cue docs always carry text or special-casing edited chapters.
3. **"Is this preparation current?" should live in one place.** Store the two revisions as columns on
   `bilingual_preparations` and expose one `currentPreparationFilter` used by the manifest, the route,
   the export and `currentPreparation`. That fixes Reuse/Simplification 6 and Efficiency 3 together.
4. **Gap handling in `pairAtTime`.** The new "preceding passage" fallback (`bilingual-format.ts:156-168`)
   is a reasonable fix at the right layer (the lookup, not each caller). Remaining caller special
   case: `switchNarration`'s `ms === 0 ? doc.pairs[0]` could fold into the same lookup ("before the
   first passage → first passage") so callers need no time-zero rule.
5. **Unknown language handled at a call site.** `prepare-bilingual.ts:27` now guards
   `context.language ? languageCode(...) : "und"` because `languageCode(null)` returns `"en"` for the
   EPUB's sake. Fine as is; if more callers appear, give `languageCode` an explicit fallback
   parameter instead of repeating the guard. Also consider moving `languageCode`/`LANGUAGE_CODES`
   out of `readaloud-epub.ts` — the worker and web reader now depend on an EPUB builder module for a
   language table.
6. **Text direction is re-derived by every consumer.** `readingDirection` (`web/src/lib/reading-lang.ts`)
   is a good fix for the web reader; the iOS reader will need the same logic. Optional: carry
   `direction` on each lane in `p2af-bilingual/1` so consumers don't each depend on `Intl.Locale`
   text-info support.

## Suggested order

1. Await/sync `readBilingualDocument` (one line, real bug).
2. Altitude 2 (fixes blocker B1 at the root).
3. Altitude 1 (banded alignment) and Efficiency 1 (cheap heartbeat).
4. Altitude 3 + Efficiency 2–4 (revision columns, hash cache, lighter status).
5. Client Efficiency 6–7 before testing a long real chapter.
6. The reuse and simplification items as the files are touched.
