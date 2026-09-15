# LLM OCR: word positions by alignment — plan and handoff

> Status (2026-09-15): **built**, the same day, on top of `docs/llm-extraction-plan.md`'s engine.
> `lib/word-alignment.ts` is the alignment, `parseTsv` in `lib/ocr-tesseract.ts` the word boxes,
> `scripts/pdf_text_layer.py` behind `lib/pdf-text-layer.ts` the copy. The plan is kept as written;
> what differs and what was measured is at the end.

## The problem

The `llm` OCR engine (`packages/server/src/lib/ocr-llm.ts`) reads each page image with a vision
model and returns clean text: paragraphs, headings, footnotes, furniture. It returns no positions,
so it writes no searchable PDF copy. Three things are lost for a book read this way:

- read-along highlights by page instead of by word (`chapters.sourceBlocks` carry no `polygon`,
  so `lib/cue-rects.ts` `polygonBox` gets `undefined`);
- the in-app PDF view has no text search, because the served file is the original image-only PDF;
- every reader that expects a text layer has a special case — `textLayerDone` in
  `lib/ocr-text-layer.ts` is the one place that knows an AI-read file is done without a copy.

Asking the model for bounding boxes is the wrong tool: dense typescript has 400 words a page,
every coordinate costs output tokens, and the precision is poor. The geometry already exists on
the machine, from a different source.

## The idea

**OCR gives geometry, the model gives text, an alignment marries them.**

The engine already runs Tesseract on every page for the fidelity check
(`makeTesseractReference` in `ocr-llm.ts`, plain-text output) and throws the geometry away.
Tesseract emits a TSV with a box for every word in the same pass — the Tesseract engine does
exactly that with `tesseract <list> <base> -l <pack> pdf tsv` (`lib/ocr-tesseract.ts`, and
`statsFromTsv` there already parses the TSV: level 5 rows are words, columns 6–9 are
left/top/width/height in pixels of the rendered image, column 10 confidence, column 11 text).

Aligned word by word to the model's text, those boxes give every clean word a position. With
positions, the engine can write the same invisible text layer Surya writes
(`scripts/ocr_surya.py`: a glyphless font drawn in render mode 3, `line_operators` /
`add_text_layer`), and the book stops being special anywhere downstream.

## The alignment

Per page, two sequences in reading order:

- `ocr`: Tesseract words with boxes and confidence, in TSV order (block, paragraph, line, word).
- `llm`: the model's words, from the page's blocks in order, split on whitespace, punctuation
  stripped for matching but kept for writing.

Align them with a dynamic-programming sequence alignment (Needleman–Wunsch; the diff family) with
fuzzy equality: two tokens match when their normalised Levenshtein similarity is at or above
about 0.7 after lower-casing and stripping punctuation. The order constraint is what makes
this work: a bag-of-words lookup cannot tell one `на` from the next, the alignment can. Pages are
a few hundred tokens a side, so the table is small; do it in TypeScript, no dependency needed.

Rules for what each kind of alignment cell yields:

- **Match** → the model word takes the OCR box.
- **Model word with no OCR partner** (Tesseract missed it) → a box interpolated between the
  nearest matched neighbours on the same OCR line; when the neighbours sit on different lines,
  put it at the end of the previous one.
- **OCR word with no model partner** (bleed-through, a misread the model corrected away, page
  furniture the model put in `furniture`) → dropped.
- **One model word over two OCR boxes** — the hyphenated split the model joined — → the union
  of both boxes when they are on the same line, else the first box; Tesseract keeps the hyphen on
  the first half, which is how to recognise the case: the two OCR tokens concatenated (minus a
  trailing hyphen) match the model word.
- **Furniture** — the model's `furniture` strings get boxes the same way (they are on the page
  and searchable) but stay out of blocks, as now.

Confidence: keep the match ratio per word. A page whose matched share is low degrades toward
line-level placement, which is still strictly better than page-level, and the fidelity score the
engine already logs names those pages.

## Where it plugs in

1. **Reference read returns words, not text.** `ReferenceReader` in `ocr-llm.ts` becomes
   `(image, pageNumber) => Promise<{ text: string; words: OcrWord[] } | null>` where `OcrWord`
   is `{ text, left, top, width, height, conf, line }` in image pixels. Run
   `tesseract <image> - -l <pack> tsv` and reuse the TSV column knowledge from
   `lib/ocr-tesseract.ts` (`statsFromTsv`) — move that parser into a shared spot rather than
   duplicating it. The fidelity check keeps using the joined text; nothing else about it changes.
2. **Pixels to PDF points.** The render is `-scale-to 1600` on the long edge, so the scale factor
   per page is `pageWidthPt / imageWidthPx` (same on both axes). Page sizes come from `pdfinfo`
   per page, or from `page_view_sizes` in `ocr_surya.py` if the writing is done in Python (below).
   Origin top-left, like Surya's events.
3. **Alignment** as a pure function `alignWords(llmWords, ocrWords): PlacedWord[]` beside the
   engine, unit-tested on the fixture (`test/fixtures/scanned-page.pdf`) and on a saved TSV of a
   Bulgarian page (page 3 of the POC book, `docs/llm-extraction-plan.md` names it).
4. **Polygons in the layout.** `toMarkerJson` gains a `polygon` per block: the bounding box of
   the block's placed words, in PDF points, in Marker's four-corner form. That alone gives the
   read-along block-level and then line-level rects through `cue-rects.ts` unchanged.
5. **The text layer.** Write a copy beside the original with one invisible string per model word
   at its box, in the glyphless font. Two ways, pick one:
   - extend `scripts/ocr_surya.py` with a mode that takes a JSON of placed words and writes the
     layer (its writer already handles `/Rotate` pages and the font), called from the engine
     the way `lib/ocr-surya.ts` calls it; or
   - write it from TypeScript with a small PDF library. Python is the one that is proven.
   Then `ensureTextLayer`'s `llm` case sets `searchablePdfPath` like the other engines, and
   `textLayerDone`, the `hasLlmLayout` predicate, the `wasRead` special case in
   `packages/web/src/components/BookFilesSection.tsx`, the `or(...)` in `books.retry`'s
   forget-text-layer, and the "no in-PDF search" copy in `OcrEngineChoice.tsx` and the README all
   go back to the plain shape. Keep the prebuilt layout and the Marker skip — the copy is for
   search and highlighting, the layout is still the model's.
6. **The POC script** (`packages/server/src/scripts/llm-extract-poc.ts`) should report the
   matched share per page next to recall, so a model or prompt change shows what it did to
   placement as well as to text.

## What to measure before trusting it

- **Matched share per page** on the POC book and the fixture: what fraction of model words found
  an OCR partner. Expect 90-plus on clean pages; the flagged pages 5 and 7 will be lower.
- **Placement error** on a handful of words checked by eye in the read-along, especially around
  hyphenated joins and footnote markers (`⁴` superscripts are exactly the tokens Tesseract and
  the model disagree on).
- **Time**: TSV instead of plain text costs Tesseract nothing; the alignment is milliseconds;
  the PDF write is the seconds Surya already pays. The engine stays network-bound.

## Open questions

- Whether the alignment should run on Surya's line boxes when Surya is available and the pack
  for Tesseract is not — Surya gives lines, not words, so placement would be line-level there.
- Whether a page where Tesseract read nothing usable (matched share under some floor) should fall
  back to a single page-sized box rather than a column of guesses.
- Whether the text layer should carry the model's furniture. Searchable page numbers are
  harmless; running heads repeated on every page inflate search hits.

## Outcome

Built as planned with three departures:

- **The special cases stay.** A book whose language has no Tesseract pack installed gets no
  reference, so no placement and no copy; the model still reads it. `textLayerDone`, the
  `wasRead` predicate and the `or(...)` in `books.retry` therefore keep knowing about a read
  without a copy. The copy is the normal case, not the only one.
- **The copy is a bonus, not a gate.** The reading is paid for by the time the writer runs, so a
  writer failure (no Python environment, a broken PDF) is logged as "No searchable copy for the
  AI's reading" and the book goes on as it did before this work, rather than failing the extraction.
- **Guessed boxes stay on the page.** A run of unmatched words after the last placed word on a
  line used to hang off to the right at the neighbour's letter width — page 17 of the POC book
  put boxes out to x = 9029 on a 2400-point page, and the viewer, which sizes a page to its
  content box, drew that page at a quarter width. A run that would leave the page is now
  squeezed into the room left before the edge (`Bounds` in `placeBlocks`).
- **Furniture stays out of the layer.** Running heads on every page would inflate search hits;
  page numbers are reachable without search. The layer carries the blocks' words only.

Scale is `pdfPageSizes` (pdfinfo) over the TSV's image width; pdfinfo reports the crop box before
`/Rotate` while pdftoppm and pdfium render the rotated view, so the sides are swapped for 90 and
270 — checked against a quarter-turned copy of the fixture. The words go to the Python writer in
points, already in the frame `ocr_surya.py` writes in, and the script is a thin caller of that
file's `add_glyphless_font` and `add_text_layer`, one string per word instead of per line.

Measured on the 19-page Bulgarian typescript scan (DeepSeek V4.1 Flash, Tesseract `bul`):

| | |
| --- | --- |
| Alignment time | 9–74 ms a page, on top of Tesseract's 2–4 s that the fidelity check already paid |
| Placed share, pages Tesseract read cleanly | 92–99% |
| Placed share, the footnote-heavy pages | 70–85% — Tesseract's own misreads (`ЗВШЕааамлеицит`), not ordering |
| Offline, against the *joined* layout | 84.7% of 11,194 words — pessimistic: the continuation glue moves each page's opening block to the previous page, so both sides of every join show a paragraph the other reader "missed" |

What the unmatched words are, from reading the lists: Tesseract misreads on small type (the
guessed box from the neighbours is the right answer there), superscript footnote markers the two
readers tokenise differently, and letter-spaced names (`Г о р о в`) the model writes as single
letters while Tesseract reads one word. None of these argued for a second pass.

Still open: aligning on Surya's line boxes when its bundle is installed and the Tesseract pack is
not; whether a page under some placed-share floor should fall back to one page-sized box.

## Second pass, the same day: the boxes were the weak link

Tesseract's layout analysis dropped the clipped, tilted lines at the foot of page 17 whole, and a
guess dressed up as a box is what the reader then showed. Apple's Vision recogniser, the OCR
behind Live Text, ships in macOS and boxes every word along the skew of its line; it read what
Tesseract skipped. No Bulgarian mode, but Russian mode with correction off returns the letters on
the page, which the fuzzy alignment is built for. `scripts/vision-words.swift` behind
`lib/ocr-vision.ts`; Tesseract stays the fidelity text in the book's own language and the box
source off macOS.

| Page, against the joined layout | Tesseract bul | Vision ru-RU |
| --- | --- | --- |
| 7, footnotes | 70.5% | 79.5% |
| 17, skewed and clipped | 74.9% | 83.8% |
| time per page | 3.3–3.8 s | 0.5 s |
| whole book, real run, unjoined | 90.8% | 93.6% |

Three more findings, each now a test:

- **Vision's boxes span the full line height**, and on a skewed page one row's boxes touch the
  next row's; `page_geometry.py` then reads two rows as one tall line and the reader cannot match
  its text. The layer string sits on the middle 60% of the box (`LAYER_BAND`), the size of the
  ink, which is what Tesseract's boxes were.
- **A block glued across the page break carries one polygon.** `joinContinuations` glued a
  continuing paragraph onto the previous page's block, so every cue in the second half was drawn
  on the first page's box — the "rects on the previous page" screenshot. Only a hyphen-split word
  is joined now; the rest stays a block per page, as Marker leaves it.
- **Placement must be re-runnable without the model.** Every fix above would have cost a paid
  re-read and a re-synthesis. The engine now keeps `llm-pages.json`, and `books.replaceWords`
  places it again, rewrites the copy and refreshes the chapters' polygons in place.
