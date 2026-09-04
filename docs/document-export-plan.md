# Document export (PDF/EPUB) — SHIPPED 2026-07-28

Book-level "Export PDF" / "Export EPUB" actions render the selected chapters into a
readable file. In a language view they render the translated text (status=done only),
in the original view the `customText ?? cleanText ?? rawText` source text.

## What shipped

- **`assembleDocument` worker** (`workers/assemble-document.ts`, extraction pool):
  payload `{ bookId, language?, format: "pdf" | "epub" }`. Sets `books.status =
  "assembling"` while running; swept/replayed on crash like `assemble`.
- **`documents` table** (migration `0020`): mirrors `assemblies` minus duration, plus
  `format`. Rows only on success. Deleted by redetect alongside assemblies.
- **HTML builder** (`lib/document-html.ts`, pure + unit-tested): cover page, TOC with
  real page numbers (`target-counter` + dotted leaders), A5 `@page` with running
  headers (book title verso / chapter title recto), justified text with `hyphens:
  auto`, light markdown from DeepSeek output (`#`/`##` headings, bold, italic)
  rendered as elements. Language attr inferred Cyrillic-vs-Latin (`bg`/`en`/`und`).
- **Title dedup**: detected on the ORIGINAL side (`titleRepeatsAsFirstLine`,
  normalize-compare `chapters.title` vs first line of source); drops the first block
  of the rendered body. Fired on 17/19 chapters of the test book.
- **Renderer** (`lib/vivliostyle.ts`): `@vivliostyle/cli` (server dep) invoked as a
  subprocess via its resolved bin, `--log-level info --timeout 1800` (the CLI prints
  its errors on stdout, so a quieter level leaves a failure as a bare "Command
  failed"). First run downloads a Chromium into the Vivliostyle cache (one-time, then
  offline). PDF renders the one-document HTML; EPUB goes through `buildPublication`,
  which writes one file per chapter plus a generated `vivliostyle.config.mjs` — one
  entry becomes one spine item, and `toc: true` writes the nav document.
- **Routes**: `books.exportDocument` / `books.documents` / `books.deleteDocument`
  tRPC; `GET /download/document/:id` with correct MIME types.
- **UI**: emerald "Export PDF/EPUB (n)" buttons next to "Assemble selected" (disabled
  with tooltips per convention), Documents table scoped to the active language view.

## Spike results (book 2c29b696, 19 ch, 1.8M chars)

- Full book → 934-page A5 PDF in ~25s, ~1.2GB peak RSS; EPUB in ~2.3s from same HTML.
- 451k-char pseudo-chapter rendered fine (226 pages).
- English hyphenation works (inherits Chromium dictionaries); TOC page numbers exact.

## Leftovers / parked

- Original-view export of garbled-OCR Cyrillic is faithful-but-garbled by design;
  Cyrillic hyphenation quality unjudged on clean source material.
- `sanitizeFilename` strips non-ASCII, so Cyrillic titles produce near-empty
  filenames (`_1_1882__english_...`); same behavior as audio assemble.
- Curiosity found along the way: 8/19 chapters of the test book error on SQL-side
  `left(raw_text, N)` ("invalid byte sequence for encoding UTF8: 0xd0") while full
  column reads are fine — looks like sliced-detoast weirdness. App code never slices
  in SQL, so harmless today.
