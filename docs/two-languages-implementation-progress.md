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

Sentence alternation is now an opt-in checkbox in the reader: selected language, counterpart, next
sentence. It uses each recording's own passage anchors, preserves pause/resume, stops at incomplete
pairs and chapter end, and returns to continuous playback when unchecked. It does not add word
clipping, narration generation or a new alignment pass.

## Export is an explicit choice (2026-09-28)

Prepared translations no longer ride along inside ordinary EPUB and synced EPUB exports; both are
single-language again. The Export dialog offers **Bilingual EPUB**: pick the translation, tick
which available recordings to include (original, translation, both or neither), and see readiness
for the selected chapters before confirming: paired chapters, word links per matched group, word
timing per recording, and a notice when a chosen recording is an older MP3. Every selected chapter
must already be paired against its current text or the export refuses with the reason; nothing is
generated on the way out. The queued job carries the language and recording choice, the output is
stored as its own `epub-bilingual` format in its own outputs group, and `export_book` on the
assistant side takes the same `bilingual` options. Server tests cover the four recording
combinations, stale-pair refusal and single-language defaults; `e2e/scripts/bilingual-export.mjs`
drives the picker in a browser.

## Readiness, pairing from anywhere, and the assistant (2026-09-29)

A trial from the assistant found the gaps: it offered a bilingual export that the dialog refused,
because one selected chapter was never paired and nothing told either of them; the pairing panel was
reachable only from a translation lane; a translation lane's chapter panel showed sentence marks but
never word marks; the tray's Translate ran a whole selection with no confirmation and no way to stop.

- `bilingual.readiness` (database only) says, per translation, which selected chapters are paired,
  fully linked, unpaired or untranslated. The tray's **Bilingual reading** button carries the count
  still to pair, is pinned, and works from the original view when the book has one translation.
- The export dialog names the unpaired chapters by number and offers **Pair sentences…**, which opens
  the pairing panel and brings the dialog back afterwards; readiness refetches while pairing runs.
  The server's refusal names the same chapters.
- `/read/variant/:id/cues.json` serves a lane's own recording timed against its own text, and the
  chapter panel reads it, so a translation narrated with word timestamps marks words like the original.
- **Translate** asks before it runs. **Stop translation** suspends the lane's pending chapters and
  deletes their queued jobs (`variants.stopTranslation`); a chapter already at the model finishes.
- Assistant/MCP: `get_book` carries a `bilingual` readiness field; `prepare_bilingual` runs the
  pairs or links stage for the selected chapters; `synthesize_book` takes `language`, `voice` and
  `speed` to narrate a lane with its own narrator; `wait_for_book`'s audio stage waits for lane
  narration too; `export_book` says to offer a bilingual export only when nothing is unpaired. The
  assistant is told a dialog it opened and a card are two ways to run one step, never both.

Walked end to end through MCP on a fresh three-chapter book: upload, extract, narrate (Kokoro),
translate to Bulgarian (DeepSeek), narrate the lane (ElevenLabs multilingual, word timestamps;
Cartesia was out of credits), pair (local), link (DeepSeek), export with both recordings, and open in
the web reader. Only Cartesia and ElevenLabs return word timestamps for
Bulgarian; the local Bulgarian narrators do not, so a Bulgarian lane narrated locally reads at
sentence granularity.

## Alternation never stops mid-chapter (2026-09-29)

A listener on headphones hit a wall: sentence alternation stopped at a pair the pairing model had
marked *uncertain*, although both recordings had timing for it, and asked them to choose another
passage. The rule is now: a pair alternates on whatever timing it has. An uncertain pairing is still
heard in both voices; a side without usable timing is skipped and the other side is heard; a pair
with neither is passed over. Only the end of the chapter ends the run, and turning alternation on
inside an untimed stretch starts at the next timed clip after the last passage the voice passed.
`sentenceSequence` keeps two entries per pair with nulls for the skipped sides; `nextSentenceIndex`
finds the next playable one. A book with no language set now infers its original lane's language
from the text (script counting) instead of writing `und`.

## The pages come along (2026-09-29)

A printed book's Bilingual EPUB now takes the synced EPUB's route when the original recording is
included: the file carries the pages, the original's cues with their page rects, the pairing and
whichever recordings were chosen, so a reader can show the print beside the translation with the
same following and zoom it gives a single language. A selected chapter without a narration of its
own keeps its pages and both texts. Without the original recording, or for a book with no pages,
the file is the two texts as before; the picker says which it will be. The exporter's text guard
compares words rather than bytes, since a printed chapter's cues rebuild paragraph breaks from
the page blocks while the pairing ran on the chapter's text.
