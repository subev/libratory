# Bilingual reader: first implementation slice

2026-09-28. Implements the first reader/export slice of the
[delivery plan](two-languages-implementation-plan.md), using already saved results. No paid model
or voice calls, database migration or changes to the native app. The reviewed checkpoint is saved
on `feat/bilingual-reader`.

## Working now

- An optional, validated [bilingual document](bilingual-format.md), keeping the existing `p2af/1`
  manifest. Text revisions, UTF-16 ranges, stable tokens, discontinuous links, unresolved groups,
  timing provenance and independent recordings are explicit.
- “Read with” in the existing web reader for chapters carrying that document. Wide paired text,
  narrow stacked text, per-lane RTL, hover/focus equivalents, click-to-listen and one audio element.
  Voice switches use the other recording's passage time and preserve play/pause. User scrolling
  suspends follow; “Back to the voice” restores it.
- The EPUB exporter packages the bilingual document and secondary audio. Import resolves the
  same data through `DocumentSource`; ordinary reading remains available. Missing secondary
  audio retains both texts. An invalid optional document does not disable ordinary reading.
- A local adapter produces three playable exports from existing recordings and model outputs:
  the real English–Bulgarian chapter, English–Hebrew and Bulgarian–German samples. These are
  review artifacts, not new books or new preparation jobs in the library.

## Try it

Start the web app and open `/open`. Choose an EPUB from
`packages/server/data/tmp/bilingual-reader/`. Prepared bilingual text opens by default; **Single language** is an explicit choice:

- `en-bg.epub`: Death and the Goose Boy, 17 sentence groups, saved Cartesia Bulgarian take.
- `en-he.epub`: ten English–Hebrew passages. The uniformly spaced provider timings are labelled.
- `bg-de.epub`: ten Bulgarian–German passages, retaining the saved mapping's known limitations.

The web reader has to load first; disconnecting afterwards does not stop these files playing.
This is offline document playback, not a claim that a new browser tab loads the web app without
a server or that a service worker was added.

Regenerate locally, without model calls (requires the saved spike outputs and ffmpeg):

```sh
cd packages/server
node --import tsx spikes/two-languages/review/export-reader.mts
```

The adapter validates the converted results and transcodes existing recordings to AAC for the
EPUB. It does not synthesize missing audio or create replacement translations.

## Verification

- Full web unit suite: 146 tests, including mapping validation, stale text, UTF-16 boundaries, discontinuous links,
  uncertain/missing counterparts, independent clocks, zero-duration words, archive resolution and
  audio URL cleanup, plus existing reader/ZIP regressions.
- Nine exporter tests, including secondary audio packaging, OPF registration, stored compression,
  stale source text, mismatched source recording and changed audio bytes. Run with
  `pnpm --filter @libratory/server test:reader`, without the Docker-backed server test setup.
- Focused browser checks cover import, inspection, playback, narrow layouts, offline playback and
  returning to ordinary reading. The repeatable check is `node e2e/scripts/bilingual-reader.mjs`
  with the web dev server running on port 3033 and the generated samples present. It is separate
  from the full E2E suite.
- Existing Swift format definitions decode all three generated manifests and their primary cues.
  This checks decoding compatibility; importing and playing them in the native app remains untested.
- Repository typecheck, lint and web production build pass. Existing lint warnings and the build's
  large-bundle warning remain. Before the checkpoint commit, the full suite passed with
  `pnpm test --maxWorkers=2` (1,106 tests). The initial unrestricted run hit database-cleanup and
  OCR fixture timeouts; reduced concurrency passed without changing tests or timeouts.

## Reader interaction revision

The first sentence-row design was too repetitive. The revised surface uses paragraph flow without
per-sentence borders or language labels, with subtle inline highlights. Paragraph breaks group
existing mappings; text/token offsets are unchanged. An extraction newline within a paired sentence
is collapsed visually, so a stray “The” does not sit above the rest of its sentence.

Click or tap a word starts that language's narration there; missing word timing falls back to the
sentence start with an explanation. Hover or keyboard focus shows a small equivalent tooltip and
marks related words without moving playback. Escape dismisses it. Touch can hold to preview or
explicitly select “Meanings on tap.” Hover content remains reachable by the pointer. Timing
provenance is available under “Timing details” instead of occupying the reading surface.

Three additional unit tests cover paragraph grouping, phrase display and seek anchors. Updated
browser checks cover hover without seeking, click/Enter playback, narrow RTL, touch hold and tap
modes, offline playback and ordinary-reader handoff. No new model or narration calls were needed.

## Next slice

Add explicit preparation from Chapters, durable independent pair/link state, visible progress,
cancellation, explicit retry and stale-input publication guards. Attach the prepared documents to
served book manifests and normal export selections. Then add the chapter-modal link with a passage
handoff. HTTP loading has the document-consumption method, but **no production preparation route
or manifest attachment exists yet**; the working examples currently enter through EPUB import.

Whole-book scheduling, native bilingual consumption, PDF crop pairing and paragraph-layout polish
remain open. The existing task stays open until the feature is implemented beyond this slice.

## Review checkpoint

Branch: `feat/bilingual-reader`. See [review handoff](bilingual-reader-review-handoff.md).
Space toggles playback after clicking or focusing a word; Enter plays from the focused word.
Tooltips prefer above the word, falling below when the sticky toolbar leaves insufficient room.
Automatic following pauses while a meaning is open. Opening another file clears the old chapter,
language choice and timestamp. An explicit single-language choice survives chapter navigation.

Review fixes add grapheme boundary validation, punctuation rendering that never absorbs the next
token, precomputed pair text/gaps and passage-anchor indexes, and explicit web dependencies.
Export rejects stale source text and recording hashes against the resources actually packaged.
Source milliseconds transfer between modes only when the source audio reference matches.
Production job publication guards remain part of the next slice, not a completed capability.

The word-only playback experiment was removed after user testing found its boundaries too
imprecise. Continuous click-to-listen and Space pause/play remain the intended behavior.
