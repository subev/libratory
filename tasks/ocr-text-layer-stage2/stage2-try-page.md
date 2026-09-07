# Stage 2 / C — Try One Page, and the engine choice in the two existing surfaces

Branch `feat/ocr-try-one-page`. Database name `libratory_trypage`. Ports `PORT=3074`, `WEB_PORT=3073`.
You own: the `/books/:id/ocr` route and page (`packages/web/src/pages/OcrTryPage.tsx` + its pane components),
`lib/ocr-try.ts` (+ `lib/ocr-try-routes.ts` for the SSE route), the `ocrTry` tRPC router (+ one registration line
in `router.ts`), the engine choice in `UploadZone.tsx` and `ExtractModal.tsx`, the `--lowconf` / `--lowconf-ring`
tokens in `styles.css`, the `spa-fallback.ts` allow-list and `main.tsx` routes, and `BookDetail`'s `?extract=1`
handling. You do NOT touch `SettingsModal.tsx`, `BookFilesSection.tsx`, `lib/ocr-text-layer.ts`,
`lib/ocr-tesseract.ts`, `scripts/ocr_surya.py`, `pyproject.toml`.

## The design is the spec

- The mock: `/private/tmp/claude-501/-Users-petur-repos-libratory/469feb73-d524-44b1-b533-8781c6dfd6a0/scratchpad/OCR Try One Page.dc.html` (55 KB; `support.js` beside it is the canvas runtime — open the
  mock in a browser from that directory to see it, or just read it). It is a Claude Design canvas file: markup with
  `sc-if`/`sc-for` bindings and a `renderVals()` function holding every copy string and formula.
- The structural summary: `/private/tmp/claude-501/-Users-petur-repos-libratory/469feb73-d524-44b1-b533-8781c6dfd6a0/scratchpad/design-summary.md` — layout, every state with exact copy, the pack row's
  four states, the token and icon inventories (which exist in the repo and which do not), and the formulas. Read it
  in full before the mock; it tells you where to look.
- `tasks/ocr-text-layer-design-review.md`: its "Keep these" list is binding. Its corrections 1, 2 and 4 are already
  reflected in this version of the mock (sizes come from a manifest; the three callout states exist; the badge tokens
  are `--badge-extracting-*`). Correction 3 (estimates are per-page × page count, from the page the user sampled) is
  what the mock does — implement exactly that formula with the real numbers.
- Prototype-only things in the mock, NOT shipped: the "Demo" `<select>` and its seven presets, the light/dark toggle
  in the header (the app has its own theme handling), the `demoSpeed` prop, the simulated timers, `LINES`, `SUB`,
  `garble`, `COND`, `LANGS` (sizes come from the manifest at runtime, never from a table in the web bundle).
- Fonts: the mock loads Fraunces / Source Serif 4 / Phosphor CSS from the network; the app cannot. Use the app's font
  stacks and the icons from `icons.tsx` (add re-exports for the Phosphor names the summary lists as missing; note
  `ph-arrow-clockwise` is `ArrowClockwise`, not the already-exported `ArrowsClockwise`).

## Decisions that are settled (from the design, confirmed by the orchestrator)

- **Full screen, own route** `/books/:id/ocr?file=<index>` (`main.tsx` lazy like `/read`, plus the
  `spa-fallback.ts` allow-list). Regions in DOM order exactly as the mock: sticky header (back link = book title,
  `Try one page`, `"1 file · 312 pages · no text layer"` computed), controls row (PAGE stepper + hint, LANGUAGE
  select with the three optgroups + pack chip, Run), the conditional language pack row, the main flex-wrap row
  (sticky image pane `flex:1 1 300px; max-width:440px` + cards wrapper `flex:2 1 470px` holding the Tesseract and
  Surya cards `flex:1 1 300px`), sticky commit bar. No media queries — flex-wrap does the narrow case, as designed.
- **Run = Tesseract only. Surya is opt-in** in its own card: the offer text (four variants in the mock, computed from
  whether Tesseract is done and the callout kind), the button `"Run Surya on page N · <dur>"`, and the fixed line
  `"It never starts on its own — a minute of your GPU is not something to spend by accident."` Warming state while
  no line has arrived, streaming with the shimmer line and meter, Stop, "Run Surya again", done with
  `"<n> lines · <s>s · nothing dropped"` and the footer "no confidence figure" line. Error states are NOT designed
  for either engine: add one plain error state per card using the app's existing error pattern (the message from
  the server, one line, `--warning-*` or the tokens the neighbours use for a failed job) — say in your report what
  you chose.
- **Entry and return.** `ExtractModal` "About this book" gets the engine choice (below) and a "Try one page…" link
  to the route. Choosing an engine on the screen writes `books.update({ ocrEngine })` immediately (the commit bar's
  "<Engine> is set on <book title>." state, with "Change" clearing it back to null? — no: "Change" only re-opens
  the choice in the UI; the book keeps the last committed engine until another is committed). "Back to Extract" /
  "Cancel" navigate to `/books/:id?extract=1`, which reopens `ExtractModal` (add the query handling to `BookDetail`).
  Nothing is lost while away: every "About this book" control writes immediately through `onUpdateBook`.
- **Engine choice, surfaces 1 and 2.** `UploadZone`: the "Scanned PDF — needs OCR" tick stays; when ticked, one line
  and the two engines as radios, Tesseract default. `ExtractModal`: replace the tick-box with three radios — "No OCR —
  the file has text" (null), Tesseract, Surya — plus, under Tesseract, the language `<select>` (Tesseract reads
  `books.language`, so reuse the existing book-language control rather than adding a second field) with the
  `<OcrLanguagePackRow code onInstalled />` under it when that pack is missing, and the "Try one page…" link. Rendered
  only under stage 1's condition (a file needs or has OCR). The one-line trade, from the plan: Tesseract — about a
  second a page, word-by-word read-along. Surya — roughly ten times slower, better on photographed, curled, faded or
  skewed pages; read-along marks a paragraph at a time.
- **The user picks the page.** Stepper + number input, default `min(5, pageCount)` clamped; hint text from the mock.
  Changing the page cancels running engines and clears results.
- **Language select** = three optgroups as in the mock: `"Detected on this page — <Script>"` (the plausible languages
  for the OSD script, from a small table you own: Latin → the book's language if Latin else eng; Cyrillic → bul, rus,
  ukr, srp, mkd, bel; Han → chi_sim, chi_tra, jpn; Arabic → ara, fas, urd; Hebrew → heb; Greek → ell; Devanagari →
  hin, mar, nep; Japanese → jpn; Hangul → kor), `"Installed"`, `"All languages — <count>"`. Preselect `books.language`
  when set and its pack exists in the manifest, else the first of the detected group. The pack chip shows the state.
- **Page image pane**: PNG from `pdftoppm -r 150 -png` cached under `data/tmp/{bookId}/ocr-try/`; the low-confidence
  overlay (boxes from the TSV word geometry scaled to the displayed size; toggle `"Where Tesseract doubted · N"`, eye
  icons, disabled until Tesseract is done); the loupe as in the mock but zooming the raster (CSS `background-size` on
  the same PNG — do it if it stays small, else skip and say so); the callout under the image with the mock's three
  states and their exact copy, computed:
    `clustered`: ≥ 75 % of doubted words have their box centre inside the leftmost or rightmost 20 % of the page box;
    head `"All N doubted words fall in the rightmost B% of the page."` (B = the narrowest band that holds them, side
    computed). The body's clause "and every one of them is a line's last word" is included ONLY when it is true for
    every doubted word (you have the line grouping from the TSV); otherwise the body drops that clause.
    `scattered`: otherwise, when the doubted fraction ≥ the garbled threshold shared with the Surya branch
    (`OCR_GARBLED_FRACTION`; until that branch merges, define the constant in `lib/ocr-try.ts` and the orchestrator
    reconciles). `clean`: below it. Put the classifier in `lib/ocr-try.ts` as a pure function over
    `{ x0, x1, conf, lastOnLine }[]` + page width, unit-tested with the three shapes.
- **Tokens**: `--lowconf` and `--lowconf-ring` added to `styles.css` with light and dark values (take the mock's).
- **Commit bar**: the mock's two states and copy, with real numbers: `tessTotal = dur(tessSeconds × pageCount)`,
  `suryaTotal = dur(suryaSeconds × pageCount)` (Surya's from the streaming run when it ran, else from a stated
  estimate of ~10× Tesseract's, labelled as an estimate), `dur()` exactly as the mock. Titles use the book's title.
- **Bundle gate**: if the Marker/Surya model bundle is not installed, the Surya card shows `<ModelBundleNotice>` for it
  in place of the offer.

## Server contract

- tRPC `ocrTry.page({ bookId, fileIndex, page })` → `{ pageCount, width, height, imageUrl, script, installedLanguages,
  bundleInstalled }`. Renders the PNG if not cached; runs OSD once per page (`tesseract page.png - --psm 0`, parse
  `Script: …`); `imageUrl` is served by a GET route under `/ocr/…` (mirror how `/pdf/:id` is registered and served).
- tRPC `ocrTry.tesseract({ bookId, fileIndex, page, language })` → `{ lines: { text, words: { text, conf, x0, y0,
  x1, y1 }[] }[], confidence, lowConfidenceFraction, elapsedMs, callout }` — one `tesseract page.png base -l <lang> tsv`
  run on the cached PNG; reuse stage 1's TSV parsing if it is exported, else extend it rather than writing a second
  parser. Fails with the stage 1 message when the pack is missing (the UI checks `installedLanguages` first).
- SSE `GET /ocr/try/:bookId/:fileIndex/:page/surya` in the shape of `translation-stream-routes.ts` (headers,
  heartbeat, client disconnect → SIGKILL). It spawns `scripts/ocr_surya.py --pdf <readablePdfPath or original>
  --page N --stream-lines` (the Surya agent writes it in parallel against this exact CLI) and forwards its stdout
  JSON lines as `data:` events verbatim:
      {"event":"start","pages":T} {"event":"page","page":N,"width":W,"height":H} {"event":"detected","page":N,"lines":n}
      {"event":"line","page":N,"index":i,"total":n,"text":"…","bbox":[x0,y0,x1,y1]} {"event":"page-done","page":N,"elapsedMs":ms}
      {"event":"done","elapsedMs":ms}
  Coordinates are PDF points, origin top-left. Develop and TEST against a stub script that emits those events with
  delays (`env.SCRIPTS_DIR` is the seam: point it at a test fixture directory). Do not write your own `ocr_surya.py`.
  Before spawning, check `bundleInstalled(...)` from `lib/model-bundles.ts` and refuse with the bundle name.

## Interfaces owned by the language-packs agent (running in parallel) — code against these, stub minimally

- tRPC `ocrLanguages.list` → `Array<{ code: string; name: string; bytes: number; installed: boolean;
  download: { received: number; total: number; error: string | null } | null }>`; `ocrLanguages.download({ code })`
  → `{ started: boolean }`.
- `packages/web/src/components/OcrLanguagePackRow.tsx` exporting `OcrLanguagePackRow({ code, onInstalled }: { code:
  string; onInstalled: () => void })` — the full-width pack row with the mock's four states; renders nothing when the
  pack is installed (except its transient "installed" state).
- Until that branch merges: add `routes/ocr-languages.ts` with a `list` that returns stage 1's language table with
  `installed` from `tesseract --list-langs`, `bytes: 0`, `download: null`, and a `download` that throws "not
  available yet"; and a placeholder `OcrLanguagePackRow` that renders the "needs download" state with the mock's copy
  and a disabled button. Mark both files with a one-line comment `// Placeholder — replaced by feat/ocr-language-packs`
  so the orchestrator takes the other branch's version at merge. Keep them tiny.

## Proof

- Unit tests: the callout classifier (three shapes, plus the last-word clause on/off), the script→languages table,
  `dur()`, the TSV→lines grouping if you wrote it.
- Route tests in the neighbours' shape: `ocrTry.page` on `e2e/fixtures/tiny-book.pdf` returns a page count and a PNG
  on disk; `ocrTry.tesseract` on a rendered page of `packages/server/test/fixtures/scanned-page.pdf` (stage 1's
  fixture) returns words with confidence in [0,1] and a `clean` callout; the SSE route forwards the stub script's
  events and kills it on disconnect.
- Manual proof pasted in the report, on your ports: upload `/Users/petur/Downloads/Options_Procedures.pdf` as a scan
  (raw-only, no extraction), open the screen, page 5: the image renders, Run fills Tesseract in about a second with a
  confidence figure and a `clean` callout with real numbers, the Surya card offers its run (stub streaming, or the
  real thing if `git log main` shows the Surya branch merged), choosing Tesseract shows the committed bar with the
  extrapolated total and "Back to Extract" lands on the book with `ExtractModal` open showing Tesseract selected.
  Screenshots at 1400 px and 900 px widths (browser tools are available to you) saved beside your report. Then delete
  the book and stop your servers.
- Docs: AGENTS.md frontend structure (the new page and route), tRPC routes list, HTTP endpoints list.
