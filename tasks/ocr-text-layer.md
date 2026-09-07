# Task: OCR Text Layer

## Goal

Give a scanned PDF a real text layer before extraction, written into a searchable copy of the file,
so that a scan behaves like a born-digital book everywhere afterwards — `pdftotext`, chapter
detection, search indexing, and word-by-word read-along.

Two engines, chosen per book by the user: Tesseract for speed and word geometry, Surya for pages
Tesseract reads badly.

## Why

Today the "Scanned PDF — needs OCR" checkbox routes OCR through Marker, which is the wrong shape
three ways over:

- **It throws the work away.** Marker's JSONRenderer stops at leaf blocks, so the recognition exists
  only for the duration of the run. Every re-extract pays for it again.
- **It can never give word geometry.** Surya returns line-level boxes by design — its README
  contrasts itself with "tesseract and others" which predict word or character level. This is not a
  bug in our pinned 0.17.1, and upgrading will not change it.
- **It is slow for what it returns.** 48 seconds of layout recognition on a 14-page scan, ending in
  one chapter of zero words.

A text layer is written once and read by everything downstream, forever.

## Measurements

All on real books, 2026-09-07. `Options_Procedures.pdf` is a flat 14-page English book scan;
`ПЪРВОТО.pdf` is a phone photograph of a Bulgarian book, curled page and all; `Странджа` is a flat
Bulgarian scan in pre-1945 orthography.

| | Tesseract | Surya |
|---|---|---|
| English book scan, 14 pages, render + OCR + PDF | **16.6s** | — |
| Flat Bulgarian scan, one page | **1.9s**, body correct | — |
| Bulgarian phone photo, one page | **8.7s**, right margin garbled | **70.4s**, near-perfect |
| Word-level boxes | **yes** | no |

The 14-page run: `pdftoppm -r 300 -png -gray` (5.3s) then `tesseract list.txt out pdf` (11.3s).
Output 1.17 MB → 2.23 MB. `pdftotext` went from 14 bytes to 27,032 characters, with **4,641 word
boxes**. `scripts/page_geometry.py` went from `{"pages": 14, "lines": 0}` to
`{"pages": 14, "lines": 444}`, carrying per-character x positions — exactly what `cue-rects.ts`
needs and what Surya cannot supply.

### The finding that shapes the UI

**Script is not the signal. Page condition is.** Tesseract read a flat Bulgarian scan well in 1.9s
and a photographed Bulgarian page badly in 8.7s. `tessdata_best` did not close that gap — it fixed a
few words on the photo and left the same margin damage, because the damage is geometric, not a
model-quality problem: the page curves away from the lens and the rightmost characters distort.
Surya's line-level vision transformer reads those lines in context and gets them right.

So "Cyrillic → use Surya" would be wrong advice. The honest rule is "pages Tesseract read badly →
use Surya", and Tesseract tells us which those are, per word, for free.

## Design Decisions

### A step, not a checkbox

A new `ocrTextLayer` job runs before `extract` when a file has no text layer. `pdfHasTextLayer` in
`lib/pdf-raw-text.ts` already answers that question in milliseconds and is already the guard that
stops a pointless Marker run.

Marker keeps `--disable_ocr` in all cases. It goes back to being a layout engine only.

### Where the output goes

The original file is never replaced. The searchable copy is written beside it and recorded in a new
`bookFiles.searchablePdfPath` (`dataPath` column, like every other file path). Everything that reads
a PDF prefers it when present and falls back to `pdfPath`.

This matches the variants idiom already used for translations: the original is preserved, the
derived thing is additive, and deleting the derived thing returns the book to where it started.

### Two engines, described by what actually separates them

Not "fast vs slow" — the real trade is **word highlighting vs accuracy on damaged pages**. The UI has
to say that, because a user who picks on speed alone will pick wrong for a phone photo, and a user
who picks Surya for a clean scan gives up read-along for nothing.

- **Tesseract** — about a second a page. Word-by-word read-along.
- **Surya** — roughly ten times slower. Better on photographed, curled, faded or skewed pages.
  Read-along marks a paragraph at a time.

Surya is reached through the same step, producing the same searchable PDF; only the box granularity
differs. The ~100-line OCRmyPDF engine plugin from the 2026-09-05 investigation is *not* reused —
OCRmyPDF hard-requires Ghostscript (AGPL, verified: it refuses to start without `gs` on PATH even
with `--output-type pdf`), and Tesseract writes the searchable PDF itself, so the whole dependency is
unnecessary. Surya's lines are written into the PDF by the same writer.

### How the user picks — three surfaces, escalating

**1. At upload.** `UploadZone` already knows the file. When it has no text layer, show one line and
the two engines, defaulted to Tesseract. No essay here; the modal has room for that.

**2. In `ExtractModal`.** Replace the `forceOcr` checkbox in the "About this book" block with the
engine choice, plus the language select for Tesseract. Only rendered when the book actually has a
file without a text layer — a control whose target does not exist should not be on screen.

**3. After the fact, with evidence.** This is the one that matters. Tesseract reports per-word
confidence in its TSV output, so after a run we know exactly how well it did. Store mean confidence
and the fraction of words below a threshold on `bookFiles`. When that fraction is poor, the book page
says so and offers the remedy:

> Tesseract read this at 71% average confidence — 68 of 444 lines look garbled. Pages that were
> photographed rather than scanned often read better with the slower engine. **Redo with Surya**

That is a suggestion grounded in a measurement of this book, made after the cheap engine has already
run, rather than a guess made from the language before anything has been read. It costs one Tesseract
pass that the user wanted anyway.

### "Try one page" — the user picks the page, and sees three things

For a user who does not want to run an engine over 300 pages to find out it was wrong.

**The user chooses the page.** Never a page we picked for them: page 1 of a scan is a cover, page 2 a
title, and neither says anything about how the body reads. A page number input defaulting to
somewhere past the front matter, and the whole point is that they can move it — to the photographed
page, the faded one, the one with the table.

**Three panes, not two.** The rendered page image beside both results, because without the image
neither result can be judged — a reader who does not know what the page says cannot tell which
transcription is right, and on a Cyrillic page in an unfamiliar orthography that is not a
hypothetical. The image is the ground truth and it is the cheapest pane to produce.

    ┌─────────────┬─────────────┬─────────────┐
    │  the page   │  Tesseract  │    Surya    │
    │  (rendered) │   1.9s      │    70s      │
    │             │  conf 94%   │             │
    └─────────────┴─────────────┴─────────────┘
                  [ Use Tesseract ]  [ Use Surya ]

Each result pane fills in as its engine finishes rather than waiting for both — Tesseract lands in
about a second, so the user is reading and comparing while Surya is still going, and can pick
Tesseract without waiting for a minute of Surya they have already decided against.

Picking an engine here sets it on the book. Offer the whole thing from `ExtractModal` next to the
engine choice.

The visual design of this panel and of the language pack control is briefed separately in
`tasks/ocr-text-layer-design-brief.md`.

### Language packs

`tessdata_best`, not `tessdata_fast`. Measured sizes, 2026-09-07:

| | size |
|---|---|
| tesseract + libtesseract + leptonica, **new** bytes in the bundle | **4.6 MB** |
| `eng` | 15.4 MB |
| `osd` (script detection) | 10.6 MB |
| `bul` | 8.8 MB |
| `fra` | 4.0 MB |
| `deu` | 8.6 MB |
| `rus` | 15.3 MB |
| 23 common languages | 239 MB |
| all 125 languages | 1.14 GB |

The binaries are free in practice: the closure is 9 MB, but libjpeg, libtiff, libwebp, libpng, zlib
and libarchive are already bundled for ffmpeg and poppler, leaving 4.6 MB genuinely new against the
82 MB `resources/bin` already ships.

**Language data is the entire cost.** Ship `eng` + `osd` only — **26 MB**. Not `bul`, and not a
curated set of likely languages: once downloading a pack is one click in the place where the user
already is, shipping guesses is worse than shipping nothing. Every other language is an on-demand
download at 4–15 MB, the pattern the Kokoro voice already establishes at 347 MB. Offline-first is not
violated: the app is offline after its downloads, not before them.

`eng` is shipped because it is the common case and the feature should work with no network at all.
`osd` is shipped because script detection is what makes the download offer intelligent rather than a
list of 125 names.

### Downloading a pack where the user already is

The download belongs in `ExtractModal`, next to the language select — not only in Settings. The
sequence that has to work without leaving the modal:

1. OSD reports `Script: Cyrillic` (or Latin, Han, …) on a sample page.
2. The language select preselects the plausible language for that script and says whether its pack is
   installed.
3. If it is not: an inline control naming the language and its exact size — *Bulgarian, 8.8 MB* — and
   downloading it in place, with progress.
4. On completion the language is selected and the one-page comparison can be run **immediately**.
   Closing and reopening the modal to pick up a pack that just landed is the failure this design
   exists to avoid.

Settings gets the same list for managing packs — seeing what is installed, removing one — but the
first-time path is the modal, because that is where someone finds out they need French.

With no network, packs that are not installed say so and why, rather than failing on click.

### Where packs live, and the staging gotcha

**Not in the app bundle** — an update replaces `Resources` wholesale and would delete every pack the
user downloaded. They go in `HOME` (`Application Support/Libratory`), alongside the Python
environment and the models, which is the rule the desktop launcher already follows.

That forces a detail worth writing down, because it costs an hour to rediscover: **`TESSDATA_PREFIX`
is a single directory, and Tesseract's PDF output needs more than traineddata in it.** Writing a
searchable PDF requires `configs/pdf` and `pdf.ttf` to sit beside the language files; point
`TESSDATA_PREFIX` at a directory holding only `.traineddata` and `tesseract … pdf` fails instantly
with no useful message. (Verified 2026-09-07.)

So the shipped `eng`/`osd`/`configs`/`tessconfigs`/`pdf.ttf` are staged from `Resources` into
`HOME/tessdata` on first run — exactly what `setup.stageRuntime` already does for `docker-compose.yml`
and the scripts — and downloaded packs drop into that same directory. One `TESSDATA_PREFIX`, shipped
and downloaded packs indistinguishable to Tesseract.

Packs are fetched from `tessdata_best` pinned by tag and checksummed, the way `scripts/pins.json`
already pins the bundled tools. A pack is a single file, so a failed download is a deleted file and a
retry, with no partial state to reason about.

Tesseract's OSD (`--psm 0`) identifies the script correctly and cheaply — verified: `Script:
Cyrillic` on the Bulgarian page, `Script: Latin` on the English one. Use it to *preselect* a sensible
language in the picker, never to decide the engine. Script tells us which traineddata to load; it
tells us nothing about whether the page is damaged.

### Schema

`books.forceOcr` becomes `books.ocrEngine: "tesseract" | "surya" | null`, `null` meaning no text-layer
step (the file already has text). Keeping the choice on the book, as `forceOcr` is today, is what
makes a re-extract reproducible.

New on `bookFiles`: `searchablePdfPath`, `ocrEngine`, `ocrConfidence`, `ocrLowConfidenceFraction`.

Migration is written in `~/repos/libratory`, never in the clone.

### Progress and cancellation

Log per page as Marker does (`OCR page 3/14`), and register an abort controller in
`lib/extract-registry.ts` so the step can be cancelled like an extraction. A cancelled step leaves no
`searchablePdfPath` and the book is exactly where it was.

## Non-Goals

- **Deskew, clean, rotate.** They alter page geometry and invalidate Marker's polygons. The 2026-09-05
  investigation established this; do not re-litigate it.
- **PDF/A output, image optimisation.** OCRmyPDF features we do not want and now do not inherit.
- **Merging the two engines** — Surya's text with Tesseract's boxes. Tempting, and the alignment
  problem between two independent recognitions of the same line is worse than it looks. Revisit only
  if the confidence advisory proves people are routinely unhappy with both options.
- **Re-OCRing files that already carry a text layer**, however bad it is. A separate problem with a
  separate signal.

## Open Questions

- Render DPI. 300 grayscale gave 1.9x file growth on a 14-page book. 200 may be enough for Tesseract
  and would cut both time and size; worth measuring on a book with small type before fixing it.
- Whether the searchable copy should replace the original on disk once the user is happy, to reclaim
  the duplicate. Probably not worth the risk, but the disk-usage view will make the duplication
  visible and someone will ask.
