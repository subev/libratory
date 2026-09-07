# Start Here: OCR Text Layer implementation

Entry point for the session that builds this. Read this file first, then the three below. **This work
is already planned and designed — the job is to execute it, not to redesign it.**

## Read these, in this order

| file | what it is |
|---|---|
| `tasks/ocr-text-layer.md` | The engineering plan. Schema, worker, where files go, non-goals. |
| `tasks/ocr-text-layer-design-brief.md` | What the UI had to solve, and why. |
| `tasks/ocr-text-layer-design-review.md` | What the design got right and the four corrections. |

The design itself lives in the Claude Design project "Libratory desktop", file
`OCR Try One Page.dc.html`.

## What is already in main

Merged ahead of this work — do not rebuild it:

- **`pdfHasTextLayer(pdfPath)`** in `packages/server/src/lib/pdf-raw-text.ts`. Three-valued:
  `true`, `false`, or `null` when pdftotext could not run at all. This is the function that decides a
  file needs OCR, and the whole step keys off it.
- **Marker no longer runs on a textless PDF with OCR off.** `extractPdf` throws before spawning, and
  detection refuses an all-blank document. Neither fallback can mint a zero-word chapter any more.

## Known limitations in that guard, carried into this work

Raised by code review on `acf2a7d` and left standing deliberately. The OCR step supersedes most of
them, so fix them there rather than patching the guard first.

- **`pdftotext` is not the authority marker uses.** Marker reads through pypdfium2/`pdftext`. A file
  whose text layer poppler decodes to nothing but pdfium reads fine would now be refused. Kept
  because poppler is already the authority the app trusts for raw text — `rawExtract` logs "Raw text
  unavailable … Extract it as Scanned PDF" from the same source — so the guard makes an existing
  verdict actionable rather than introducing a second opinion, and it fails with a named remedy
  rather than silently. **When the OCR step lands, the probe should agree with whatever actually
  reads the file.**
- **The probe is strictly "any text at all", not a density threshold.** A scan carrying page numbers
  or a per-page watermark passes the guard and still burns a full marker run. This is deliberate: a
  threshold trades a rare wasted run for a rare wrongly-refused book, and refusing a real book is the
  worse failure. Revisit only with a measurement, not a guess.
- **A file failed by the guard is left `status: "failed"`,** and `extractChapters` only moves `raw` →
  `pending`, so re-running extraction skips it — the `retry` route is what resets file status. The
  error message says "retry the file" for that reason. Making the two paths agree is a separate fix.
- **`redetect` deletes chapters, assemblies, documents and audio before detection runs,** so a book
  with unreadable marker output ends `failed` with everything removed. Pre-existing — the
  `totalDetected === 0` throw has the same shape — but the new throw is another way to reach it.

## Do not reopen these

Each cost real time to settle. The reasoning is in `tasks/ocr-text-layer.md`; this is the summary so
nobody relitigates from first principles.

- **OCRmyPDF is out.** It hard-requires Ghostscript (AGPL), verified — it refuses to start without
  `gs` on PATH even with `--output-type pdf`. Tesseract writes the searchable PDF itself, so the
  dependency buys nothing.
- **Surya cannot give word boxes.** Line-level is its documented design, not a bug in our pinned
  0.17.1. Upgrading will not change it. Word-level read-along on scans comes from Tesseract or not
  at all.
- **Marker stays `--disable_ocr` in every case.** It is a layout engine now.
- **No deskew, clean, or rotate.** They alter page geometry and invalidate Marker's polygons.

## Measurements — use these, do not re-derive them

Taken 2026-09-07 on real books. Re-running them costs an hour and changes nothing.

- 14-page English scan, end to end: `pdftoppm -r 300 -png -gray` 5.3s + `tesseract list.txt out pdf`
  11.3s = **16.6s**. 1.17 MB → 2.23 MB.
- Result: `pdftotext` 14 bytes → 27,032 chars, **4,641 word boxes**, and `scripts/page_geometry.py`
  `{"pages":14,"lines":0}` → `{"pages":14,"lines":444}` with per-character x positions.
- Flat Bulgarian scan, one page: Tesseract **1.9s**, body correct.
- Photographed Bulgarian page, one page: Tesseract **8.7s**, right margin garbled; Surya **70.4s**,
  near-perfect. `tessdata_best` does not close that gap — the damage is geometric, not model quality.
- Bundle cost: Tesseract + libtesseract + leptonica = **4.6 MB new** (the rest of its closure is
  already bundled for ffmpeg and poppler). `eng` 15.4 MB, `osd` 10.6 MB. Ship those two only.

## Sequencing — contract first, then agents

Fanning out before the contract exists gives three different shapes for the same three columns.

**Stage 1, one agent, no parallelism.** Land the schema and the tRPC surface, proven end to end with
Tesseract hardcoded and no UI beyond what already exists:

- `books.forceOcr` → `books.ocrEngine: "tesseract" | "surya" | null`
- `bookFiles.searchablePdfPath`, `ocrEngine`, `ocrConfidence`, `ocrLowConfidenceFraction`
- the `ocrTextLayer` worker, running before `extract`, writing the searchable PDF beside the original
- every PDF reader prefers `searchablePdfPath` and falls back to `pdfPath`

Done when a scanned book uploaded through the existing UI comes out with a text layer, chapters, and
non-zero `lines` from `page_geometry.py`.

**Stage 2, three agents in parallel** once stage 1 is merged:

- **Surya engine** — same step, same output, line-level boxes.
- **Language packs** — pinned manifest, download, staging, Settings list.
- **Try One Page** — the screen, per the design and the review's corrections.

## Hard constraints

- **Migrations are authored in `~/repos/libratory`, never in `~/repos/libratory-clone`.** The clone
  has its own database on port 5434; a migration written there is one nobody else receives.
- **`TESSDATA_PREFIX` is one directory and needs more than traineddata in it.** Writing a searchable
  PDF requires `configs/pdf` and `pdf.ttf` beside the language files, or `tesseract … pdf` fails
  instantly with no useful message. Stage the shipped files into `HOME/tessdata` on first run —
  `setup.stageRuntime` already does exactly this for `docker-compose.yml` — and land downloads in the
  same directory. Packs must not live in the app bundle; an update replaces `Resources` wholesale.
- **Icons come from `packages/web/src/components/icons.tsx`.** The repo already uses Phosphor behind
  app-specific names, so the design's choices map directly — but `<i class="ph ph-…">` and inline
  SVG are rejected by `scripts/check-icons.mjs`.
- **Language pack sizes come from a generated manifest.** The sizes in the design mock are invented
  for 13 of 18 languages; see the review. Never hardcode them.
- **Read `AGENTS.md` on type safety before writing code.** Statuses and kinds are unions, never
  `string`.
- **Tests go beside the code they test**, in the shape the neighbouring tests already use. Do not mock
  Drizzle — use the real test database, as every worker test does.
- **Comments only for non-obvious intent.** The repo's existing comments explain *why*; none of them
  narrate what the line does. Match that and nothing more.

## Delete this file, and the other three, when the work ships

`AGENTS.md`: "After implementing a feature, check `tasks/` for any related task files and delete
them."
