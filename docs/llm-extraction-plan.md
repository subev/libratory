# LLM extraction — plan and handoff

> Status (September 2026): not started. Written after the first agent-driven run on a scanned
> Bulgarian book, whose narration carried OCR damage that no later stage could repair. Facts
> below were checked on 2026-09-14; prices move, re-check them before quoting.

## The problem

A PDF without a text layer goes through OCR (Tesseract by default, Surya optionally, `lib/ocr-text-layer.ts`) into a searchable copy, then Marker reads that copy for layout and chapters. Two things go wrong on the way, and both are baked in by the time any later stage sees the text:

- **Line-end hyphens vanish.** The OCR joins `обо-` and `собена` as `обо собена`, `це-` and `лия` as `це лия`. The hyphen is gone from `raw_text`, so the clean stage cannot know the two halves were one word, and the narrator says both halves. On the run that prompted this document, every chapter had several of these.
- **The small OCR quirks.** Misread letters in context, running headers and page numbers inside the prose, columns read in the wrong order. Each is small; a narrated chapter carries all of them.

The existing repair is AI cleanup (`chapters.queueCleanup`, DeepSeek per chapter into `customText`), which is a second pass over damaged text. A vision model reading the page *image* produces clean text in one pass: it joins hyphenated line breaks because it reads words, not glyphs; it reads Cyrillic in context; it can mark headings and leave the page furniture out. This is not a replacement for the local path. It is a third engine, cloud-only and opt-in, for the case the local engines handle worst: scans.

## Facts

Which configured providers can see images, with prices per million tokens, from `packages/server/data/model-catalog.json`:

| Model | Input | Output | Notes |
| --- | --- | --- | --- |
| `deepseek-v4-flash` (also `deepseek-flash`) | $0.15 | $0.60 | image input since 2026-09-10 |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 | |
| `gpt-5-nano` | $0.05 | $0.40 | |
| `claude-haiku-4-5` | $1.00 | $5.00 | |

A page image costs roughly 800–1,500 input tokens depending on resolution; a page of prose is about 400 output tokens. A 300-page book is therefore about 360k tokens in and 120k out — around **$0.10–0.15 on DeepSeek**, under a dollar on any of them. Marker takes about 30 minutes for the same book on an Apple Silicon Mac; parallel page calls take minutes. Every LLM call already goes through `lib/llm.ts` (AI SDK), and `resolveLlm(key)` returns a `LanguageModel` that accepts image parts in a `messages` array, so no new provider code is needed.

## Where it plugs in

The extraction path today, for one file:

1. `workers/extract.ts` → `ensureTextLayer` (`lib/ocr-text-layer.ts`): if the PDF has no text layer, run the OCR engine and store a searchable copy in `book_files.searchable_pdf_path`. `readablePdfPath` hands that copy to every later reader.
2. `lib/marker.ts` `runMarker*` writes Marker's JSON into the file's `outDir` (`bookTmpDir(bookId)/file_<index>`).
3. `collectBlocksFromMarkerOutput(outDir)` flattens that JSON into `FlatBlock[]` — `{ type, text, page, level?, polygon?, included }`, where `type` is Marker's `block_type` (`Text`, `SectionHeader`, `ListItem`, … and the page furniture types that `KEEP_BLOCK_TYPES` excludes).
4. Chapters are cut from those blocks: `detectBoundaryIndices` + `sliceChaptersAtIndices` (rules), or `lib/toc-detect.ts` (the AI table-of-contents flow), into `ExtractedChapter { title, text, pageStart, pageEnd, sourceBlocks }`, then `insertSuspendedChapters`.
5. Everything afterwards reads the same outDir again: the structure view (`books.structure`), proposals (`propose` worker), re-detection (`redetect`), manual boundaries (`applyChapterBoundaries`), and the read-along's page mapping through `chapters.sourceBlocks`.

The design that keeps all of step 5 working unchanged: **the LLM engine writes a Marker-compatible JSON into the same outDir and skips Marker.** One block per paragraph or heading, `block_type` `Text` or `SectionHeader`, `html` carrying `<hN>` for heading level (that is what `extractHeadingLevel` reads), `polygon` absent, one page group per page. Then `collectBlocksFromMarkerOutput` does not know or care which engine wrote the file, and nothing downstream needs a branch. Do not fork the pipeline; emit the contract.

Two consequences to accept and document:

- **No polygons.** Marker gives each block a box, which the read-along uses for per-line highlighting on the page. The LLM gives none, so these books highlight at page granularity. Scanned books already get no word rectangles (`docs/read-along.md`, the Surya finding), so this is no regression for the case the engine is for. Page numbers stay exact because each call is per page.
- **No searchable copy.** The `.ocr.pdf` beside the original is what the in-app PDF view searches and what `pdftotext` later reads. The LLM engine should still fill `book_files.raw_text` (search index, Ask AI, `get_book_text`) from its own output; the PDF view keeps rendering the original page images and loses in-PDF text search for these books. Acceptable; say so in the engine's hint.

## The engine

- **Rendering.** `pdftoppm` is already a dependency (`lib/ocr-tesseract.ts` renders at 300 DPI in 20-page chunks). 150 DPI grayscale is enough for a model and roughly halves the input tokens; measure both on the POC book.
- **Prompt.** One page per call, or a small batch with explicit page markers if a model handles it faithfully. Verbatim transcription in the book's language; join words split by a line-end hyphen; keep paragraph breaks; mark headings with their level; put running headers, footers and page numbers into a separate `furniture` list rather than dropping them, so nothing is silently lost; say whether the page's last paragraph continues on the next page. Ask for strict JSON (`{ page, blocks: [{ type, level?, text }], furniture: [], continues: boolean }`), through the AI SDK's structured output, not free text parsed by regex.
- **Page joins.** When `continues` is true, the first block of the next page is appended to the last block of this one before the JSON is written, so a sentence does not become two blocks and later two chunks.
- **Concurrency and limits.** A handful of parallel page calls, capped, with retry on rate limits; the `translate` pool is the nearest model for a cloud-bound worker. The whole run is one job so cancel and progress work like extraction does today (`appendLog` with page x/y).
- **Fidelity check, per page.** Compare the model's text with the local OCR text for the same page (Tesseract is always available; run it just for this comparison if the book is not otherwise OCR'd): word-set overlap and a dropped-line estimate. Log the score; flag pages under a threshold for a second call with a stricter prompt, and fall back to the local engine for a page that fails twice. This is the guard against the two failures an LLM has and OCR does not: silently omitting a passage, and "helpfully" rewording one.
- **Selection.** `OCR_ENGINES` (`schema.ts`) gains `"llm"`; it is a TypeScript enum over a `text` column, check whether a migration is needed at all. The picker under "About this book" and the MCP `ocrEngine` parameter pick it up from the same constant. The model comes from the default model resolution (`defaultModelKey`) with an optional per-book override, the way `chapterModel` works. The bundle gate does not apply (nothing to download); the key gate does — refuse with the Settings pointer when no vision-capable provider is configured, and show the estimated cost from the page count before starting.

## Order of work

1. **POC script first, no product code.** A `tsx` script in `packages/server/src/scripts/` that takes a PDF path and a model key, renders pages, calls the model, and writes three things beside the PDF: a Markdown file with page markers (for reading), the Marker-compatible JSON (to prove the contract by running `collectBlocksFromMarkerOutput` + `detectBoundaryIndices` on it), and a fidelity report per page against Tesseract with total cost and wall time. Run it on the scanned Bulgarian book from the first agent run beside its Surya output and read both. Then on `packages/server/test/fixtures/scanned-page.pdf`. This costs cents and answers whether the idea is worth the rest.
2. If it wins: `lib/ocr-llm.ts` doing what the script does, called from `ensureTextLayer`'s place in `workers/extract.ts` when the engine is `llm`, writing the outDir JSON and `raw_text`, and skipping `runMarker`.
3. Engine in the enum, the picker hint (cloud, cost, no in-PDF search), the cost preview, the key gate, the MCP enum.
4. Tests: the JSON-to-blocks conversion (pure), the page-join rule (pure), the fidelity score (pure), and one integration test on the fixture with the model call mocked.
5. Docs: README languages table (a scan in any language the model reads), `docs/mcp.md` (`ocrEngine: "llm"`), AGENTS.md pipeline section.

## Risks to measure, not assume

- Omitted passages and reworded sentences — the fidelity check exists for these; decide the threshold from the POC numbers, not in advance.
- Tables, footnotes, poetry and multi-column pages — check the POC book for each; decide whether to keep them as `Text` blocks or exclude them like Marker's furniture types.
- Hallucinated headings — a model that invents a `SectionHeader` changes chapter detection; compare heading counts with Marker's on a text-layer book.
- Cost surprises — the estimate in the UI must come from the real page count and the current catalog price, and the run should stop when the provider errors rather than retrying into a bill.
- Privacy — page images leave the machine. The engine is opt-in per book, labelled cloud like the cloud voices, and never a default.

## Open questions

- Batch size: one page per call is simplest and most faithful; test whether 4–5 pages per call with markers is as faithful, since it cuts the per-call overhead.
- Whether to run the LLM engine over the text layer of a *non-scanned* PDF too, for books whose text layer is itself bad (old scans with a poor embedded OCR layer). The plumbing is the same; the trigger is different.
- Whether the fidelity comparison should use Tesseract in the book's language (needs the pack) or `eng` only for overlap counting. Overlap on Cyrillic against an English pack is meaningless; the comparison needs the right pack or a script-agnostic measure such as character-count and line-count ratios.
