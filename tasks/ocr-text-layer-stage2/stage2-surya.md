# Stage 2 / A — Surya engine

Branch `feat/ocr-surya`. Database name `libratory_surya`. Ports `PORT=3054`, `WEB_PORT=3053`.
You own: `scripts/ocr_surya.py`, `lib/ocr-surya.ts`, the `"surya"` arm of the switch in `lib/ocr-text-layer.ts`,
`pyproject.toml`/`uv.lock` (one dependency at most), `books.redoOcr`, the advisory on the file row in
`BookFilesSection.tsx`. You do NOT touch `ExtractModal.tsx`, `UploadZone.tsx`, `SettingsModal.tsx`, `styles.css`.

## Verified facts (do not re-derive)

- surya-ocr 0.17.1 in `.venv`. Python API used by its own CLI (`.venv/lib/python3.12/site-packages/surya/scripts/ocr_text.py`):
  `FoundationPredictor()`, `DetectionPredictor()`, `RecognitionPredictor(foundation)`; `rec_predictor(images,
  task_names=[TaskNames.ocr_with_boxes]*n, det_predictor=det, highres_images=..., math_mode=False)` returns one
  `OCRResult` per image with `text_lines: TextLine[]` — each has `text`, `bbox`, `polygon`, `confidence`, `chars`
  (per-character boxes with `bbox_valid`), and `words` when `return_words=True` (`words_from_chars`).
- Marker's weights are the "Marker/Surya" model bundle (`lib/model-bundles.ts` `bundleInstalled(id)`, 5.1 GB); every
  Python subprocess runs with `HF_HUB_OFFLINE=1`. Read `lib/marker.ts` for how the interpreter, env, device (mps on
  darwin, cuda/cpu via `readCapabilities()` elsewhere) and abort (SIGKILL) are handled; do it the same way.
- Measured: a photographed Bulgarian page takes Surya ~70s on this Mac; a flat scan is faster. `pdftoppm` renders at
  300 dpi; surya's `CLILoader(..., highres=True)` loads PDF pages itself via pypdfium2 (already a dependency).
- No PDF writer is installed: no pymupdf, pikepdf, reportlab, pypdf. `pypdfium2 4.30.0` and `Pillow` are.
- `TESSDATA_PREFIX` dir (or Homebrew's `/opt/homebrew/share/tessdata`) holds `pdf.ttf`, the glyphless font Tesseract
  embeds so its text is extractable but draws nothing (Apache-2.0, from the tesseract repo).

## Decisions

1. **Same step, same output.** `lib/ocr-surya.ts` implements `OcrRunner` exactly like `lib/ocr-tesseract.ts` — same
   input, same `outPdfPath`, same log style (`OCR page N/total`), same abort semantics, workDir cleaned up — by
   spawning `scripts/ocr_surya.py`. It returns `{ confidence: null, lowConfidenceFraction: null }`: Surya's line
   confidence is not comparable to Tesseract's word confidence and the design refuses a fake comparison.
   Before running, check the model bundle is installed and fail with the bundle's name if not.
2. **Writer licensing.** The searchable copy is the ORIGINAL pages with an invisible text layer added — never a
   re-rendered page. PyMuPDF (AGPL) and Ghostscript/OCRmyPDF are out. Use `pypdf` (BSD-3, pure Python — add it to
   `pyproject.toml`, relock with `/Users/petur/repos/libratory/.uv/uv lock`, and PROVE the lock moved nothing else:
   `transformers` stays 4.57.6, marker/surya/torch pins unchanged) — or pypdfium2's raw API if you can make it write
   text objects with an embedded font. Mirror Tesseract's technique: embed the glyphless `pdf.ttf` (copy it to
   `scripts/glyphless.ttf` so it does not depend on tessdata being present) as a CIDFontType2 with Identity-H and an
   identity ToUnicode CMap, text render mode 3, one `Tj` per line at the line's bbox with font size = line height
   and horizontal scaling (`Tz`) so the string spans the box width. Coordinates: surya works in image pixels of the
   page it rendered; convert to PDF user space (points, origin bottom-left) using the page's MediaBox/CropBox and
   rotation — a rotated page is the classic mistake, test one.
3. **Script CLI — this exact interface, the Try One Page agent codes against it in parallel:**
       python scripts/ocr_surya.py --pdf <in.pdf> --out <out.pdf> [--page N] [--stream-lines]
   - Without `--page`: every page, `--out` written atomically (temp then rename).
   - `--page N` (1-based): that page only; `--out` may be omitted, in which case no PDF is written.
   - stdout is one JSON object per line, nothing else; logs go to stderr:
       {"event":"start","pages":T}
       {"event":"page","page":N,"width":W,"height":H}                 (PDF points, origin top-left, y down — the
                                                                        same frame the rendered PNG uses)
       {"event":"detected","page":N,"lines":n}                        (after detection, before recognition)
       {"event":"line","page":N,"index":i,"total":n,"text":"…","bbox":[x0,y0,x1,y1]}   (same frame)
       {"event":"page-done","page":N,"elapsedMs":ms}
       {"event":"done","elapsedMs":ms}
   - `--stream-lines`: recognise in small chunks (about 4 lines, reading order) so `line` events arrive progressively
     — the Try One Page screen shows "Line 8 of 22 · 34s elapsed · about 36s left" from them. Without the flag,
     recognise a whole page per batch (fast path for the worker) and emit the `line` events after the page.
   - Exit non-zero with a one-line stderr reason on failure. SIGKILL must leave no `--out` file.
4. **Surface 3 — the advisory with evidence.** In `BookFilesSection.tsx`'s file row, when
   `ocrEngine === "tesseract"` and `ocrLowConfidenceFraction >= 0.15` (one exported constant, `OCR_GARBLED_FRACTION`
   in a server lib the route also uses), show one sentence with the numbers from THIS file (`ocrConfidence`,
   `ocrLowConfidenceFraction`, formatted as percentages): "Tesseract read this at 71% average confidence — 15% of
   words look garbled. Pages that were photographed rather than scanned often read better with the slower engine."
   and a button **Redo with Surya**. Nothing when the fraction is fine or the engine is Surya.
5. **`books.redoOcr({ id, engine })`** = forget the text layer, set the engine, re-extract from scratch:
   unlink each file's searchable copy and null the four OCR columns, set `books.ocrEngine`, then do exactly what the
   existing full-scope re-extract does (find the route ExtractModal's full re-extract calls — it resets chapters via
   `resetChaptersKeepingInserted`, keeps inserted chapters, deletes audio/assemblies/documents — and reuse it, do not
   copy it). `extract` then re-OCRs inline with the new engine. Because it is destructive, the client confirms with
   the native `confirm()` naming what is replaced whenever chapters exist, like every other destructive scope.
   Refuse for `kind !== "pdf"`. The Marker/Surya bundle gate applies here too — a missing bundle is an error that
   names it, not a queued job that fails a minute later.
6. **The measurement, not a redesign.** `tasks/ocr-text-layer.md` says Surya cannot give word boxes; 0.17.1's
   `return_words=True` says otherwise, via `chars` with `bbox_valid`. Run the photographed Bulgarian page
   (`find ~/Downloads ~/Desktop -iname "*ПЪРВОТО*"`; if absent use any scanned page you can find) with
   `return_words=True`, report: number of lines, words, fraction of chars and words with `bbox_valid`, and save an
   overlay PNG drawing the word boxes to your report directory (`surya.debug.text.draw_text_on_image` or PIL).
   Keep line-level placement as decided; make the writer's placement unit (`"line" | "word"`) a parameter so the
   switch is one line if the orchestrator decides on the data. Report the numbers; do not flip the default.

## Proof

- Unit tests beside the code: `lib/ocr-surya.test.ts` in the shape of `lib/ocr-tesseract.test.ts` — the real script on
  a one-page image fixture is too slow and needs a 5 GB bundle, so test the TS side against a stub script that emits
  the JSON events (put the stub under the test fixture location the neighbours use; `env.SCRIPTS_DIR` is the seam)
  plus one `@slow`-style real run guarded on the bundle being installed and skipped otherwise, if the neighbours have
  such a pattern — otherwise say so and keep the real run as the manual proof below.
- Manual proof, pasted in the report: the photographed Bulgarian page and the 14-page English scan through
  `ensureTextLayer` with engine `surya` (a script or the running app on your ports): `pdftotext` character count,
  `pdftotext -bbox-layout` line count, `scripts/page_geometry.py` output, and that the in-app reader (`/pdf/:id`)
  shows selectable text over the page. Time per page for both files.
- `books.redoOcr` route test in `routes/books.test.ts` shape: sets engine, nulls the OCR columns, keeps inserted
  chapters, queues `extract`.
- Docs: AGENTS.md job flow and Key External Tools mention Surya as an OCR engine reached through the step; the
  licensing note for `pypdf`/`glyphless.ttf` goes wherever third-party notices live (look before inventing a place).
