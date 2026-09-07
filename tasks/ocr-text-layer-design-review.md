# Design Review: OCR Try One Page

Reviewed against `tasks/ocr-text-layer-design-brief.md` and the engineering plan
`tasks/ocr-text-layer.md`, by the engineer who wrote both. File reviewed:
`OCR Try One Page.dc.html`.

Short version: this is good, it solved the hardest question in the brief, and there are four
factual corrections plus one decision to confirm before it gets built.

## Keep these — they are the design, not decoration

Whoever implements this may be tempted to drop them for scope. They should not.

1. **The low-confidence overlay on the page image, and the sentence under it.** "All 16 shaded words
   sit in the right 18% of the page. Damage in one band, not scattered — the edge that curled away
   from the camera." That is open question 5 in the brief answered properly: it makes *the reason*
   one engine is losing visible, instead of leaving the user to compare two walls of text in a script
   they may not read. It is the best idea in the file.
2. **Tesseract blocked without a language pack while Surya runs anyway.** Not specified in the brief,
   and correct — it turns the offline and no-pack states from dead ends into a usable path.
3. **"No confidence figure: Surya reports none, so there is nothing to compare against 71%."**
   Refusing a fake comparison is right. An empty number beside 71% would have read as a loss.
4. **Surya streaming line by line**, with the shimmer on the line in flight and
   "Line 8 of 22 · 34s elapsed · about 36s left". This is open question 2 answered.
5. **The commit bar naming the consequence** — "all 312 pages … about 6 hours". Checked against the
   measurements: 312 x 70.4s = 6.1 hours. Correct.
6. **Stop, on Surya.**

## One decision to confirm, not a correction

**The brief said this panel lives inside `ExtractModal`. The design is a full screen** — `100vh`, a
sticky header with a back link, a sticky commit bar, "Back to Extract" / "Cancel".

The engineering view is that the design is right and the brief's constraint was wrong: three panes of
prose plus a page image do not fit a modal, and forcing them in would have produced something worse.

But it is a real change, so it needs to be deliberate rather than discovered during the build. As a
full screen it needs its own route, an entry point in `ExtractModal` that navigates away, and a
defined return path — including what happens to the modal's other unsaved settings while the user is
away. Please confirm this was the intent, and say what the return should do.

## Four corrections

### 1. Thirteen of the eighteen language pack sizes are wrong

Only the five quoted in the brief (`eng`, `bul`, `fra`, `deu`, `rus`) match reality. The rest appear
to have been reasonable guesses. Measured against `tessdata_best`:

| language | file says | actual |
|---|---|---|
| Spanish | 6.5 MB | **13.6 MB** |
| Italian | 6.2 MB | **8.9 MB** |
| Greek | 5.1 MB | **8.9 MB** |
| Serbian | 7.4 MB | **9.3 MB** |
| Polish | 7.1 MB | **12.0 MB** |
| Turkish | 8.2 MB | **7.5 MB** |
| Arabic | 7.8 MB | **12.6 MB** |
| Hebrew | 5.4 MB | **3.7 MB** |
| Hindi | 9.6 MB | **11.9 MB** |
| Japanese | 13.8 MB | **14.3 MB** |
| Korean | 12.4 MB | **12.5 MB** |
| Chinese, Simplified | 14.9 MB | **13.1 MB** |
| Ukrainian | 11.2 MB | **10.9 MB** |

This does not change the design — sizes come from a generated manifest at runtime, and the layout
has to survive any of them. It matters because these numbers will be copied into code by whoever
builds it unless the file says not to. Some are off by 2x, and a download that says 6.5 MB and
fetches 13.6 MB is a bug report.

Worth checking the layout holds for the longest label: **"Chinese, Simplified — 13.1 MB"**.

### 2. "This page was photographed, not scanned" is asserted as certain

The app can genuinely compute this — Tesseract returns a box and a confidence for every word, so
"are the low-confidence words clustered in one edge band, or scattered?" is a real measurement, and
the design is right to make it the headline.

What is missing is the other outcome. A flat scan that Tesseract read badly for a different reason —
faint print, an unusual typeface, an archaic orthography — produces *scattered* low-confidence words,
and this panel would still confidently tell the user their page was photographed.

Please design the second state: what this callout says when the damage is real but not clustered.
And ideally the third: what it says when confidence is high and there is nothing to report, since
that is the common case for a clean scan and the panel currently assumes trouble.

### 2b. The evidence copy changed while this review was being written

The callout now reads "Every one of the 16 shaded words is the last word on its line", replacing
"All 16 shaded words sit in the right 18% of the page", on the grounds that the new claim is true by
construction.

It is true by construction **of the mock data** — in `LINES` the doubted word is always the last
entry on the row. It will not be true of real output, and it is the weaker of the two claims.

"Last word on its line" does not imply edge damage. A paragraph's final line stops mid-page, so its
last word is nowhere near the margin; and real curl damage usually takes the last *two or three*
words, not exactly one. Conversely the original claim — the doubted words all fall in the rightmost
band of the page box — is exactly the thing that implies "this edge was farther from the lens", which
is the conclusion the sentence goes on to draw.

Both are computable: Tesseract gives a box and a confidence per word, so we have both the x-extent
and the line grouping. Please go back to the spatial claim, or state both. The engineering side will
compute whichever the copy needs; the geometric one is the only one that supports the diagnosis.

### 3. The per-book estimates come from hardcoded constants

`TESS_AT = 1.9` and `SURYA_TOTAL = 70.4` are measurements from the engineering investigation, and
they are from **two different pages**: 1.9s was Tesseract on a flat scan, 70.4s was Surya on a
photographed page. Tesseract took 8.7s on that same photographed page — 4.5x its own flat-scan time.

So "about 1 second a page" and the 6-hour projection are not stable facts; they depend on the page.
The build should extrapolate from the page the user actually sampled. Nothing in the layout needs to
change, but the copy should be written knowing the numbers are computed and can vary widely — avoid
phrasing that only reads well for one particular value.

Related: the Tesseract card never states its own whole-book total, where Surya's card effectively
does via the commit bar. For a 312-page book that is about 10 minutes against about 6 hours, and the
asymmetry is the single most decision-relevant number on the screen. Consider showing both.

### 4. Tokens and icons

- `--lowconf` and `--lowconf-ring` are new. They are a good addition — nothing existing carries
  "the machine doubted this" — so please propose them as real additions to
  `packages/web/src/styles.css` rather than local overrides, with light and dark values.
- `--badge-extract-bg` / `--badge-extract-text` do not exist. The repo has
  `--badge-extracting-bg` / `--badge-extracting-text`. Use those.
- **Icons are fine.** The repo already uses Phosphor, re-exported through
  `packages/web/src/components/icons.tsx` under app-specific names. The implementation cannot use
  `<i class="ph ph-…">` — `scripts/check-icons.mjs` rejects it — but every icon chosen here maps
  directly. No redesign needed; naming them in that module is a build step.

## Two implementation notes, so nobody chases the mock

Not design problems — but they change what "the same thing" means when built.

- **The page image is simulated in CSS**: a gradient page with
  `transform:perspective(820px) rotateY(-6deg)`, and the loupe re-renders that markup at 2.4x. The
  real thing is a PNG rendered by `pdftoppm` on demand, and the magnifier has to zoom a raster.
  Whether the real page image needs the drop shadow and dark surround treatment is a design question
  worth answering explicitly, since it will not come for free.
- **Running both engines on every click** starts about 70 seconds of local GPU work. There is a Stop
  and Tesseract lands in a second, so this is defensible — but it is a heavy job behind one button.
  If you have a view on whether Surya should be opt-in ("also try Surya") rather than automatic, say
  so; otherwise the current behaviour will ship as designed.

## Questions from the brief still open

Question 4 — how much room the language pack control deserves — was answered implicitly by giving it
a full-width row that appears and disappears. That reads well in the mock. It is worth one explicit
check: what the screen looks like for the common case where the pack is already installed and the row
never appears at all, since that is what most users see most of the time.
