# Design summary — `OCR Try One Page.dc.html`

Source: `/private/tmp/claude-501/-Users-petur-repos-libratory/469feb73-d524-44b1-b533-8781c6dfd6a0/scratchpad/OCR Try One Page.dc.html` (Claude Design canvas mock; `support.js` beside it is the canvas runtime, not app logic, and was not read).

**Note on instructions-in-data:** the file contains no text that reads as an instruction directed at an assistant — it is UI copy, mock data, and component logic throughout. Nothing here was treated as a command; this document only describes what the file contains.

The file is a single `Component extends DCLogic` (a Claude Design canvas convention) whose `renderVals()` returns a flat object of template bindings (`{{ x }}`) consumed by the markup above it via `sc-if` / `sc-for` directives. All copy strings below are quoted verbatim from that render function or from the static markup.

---

## 1. Page layout

Root (line 46): `<div data-screen-label="OCR · Try one page" style="min-height:100vh;display:flex;flex-direction:column;...">` — full-height flex column, not a modal.

Regions, in DOM order:

1. **Header bar** (line 48) — `position:sticky;top:0;z-index:20`, `min-height:48px`, `background:var(--bg-card)`, bottom border. Contents left→right: back link "Първото стъпало" (`ph-arrow-left`), a 1px vertical divider, `<h1>Try one page</h1>`, a status span `"1 file · 312 pages · no text layer"`, a flex spacer, a "Demo" `<select>` (see §2 for its options — this is a prototype-only control, not part of the shipped screen), and a light/dark toggle button (`ph-moon`/`ph-sun`).
2. **Controls row** (line 68) — not sticky, `background:var(--bg-card)`, bottom border. Three clusters separated by 1px vertical dividers:
   - **Page**: label "PAGE", a stepper (`ph-minus` / number input / `ph-plus`), and a hint `"Aim at the worst page you have, not the first one."` (`max-width:26ch`).
   - **Language**: label "LANGUAGE", a `<select>` with three `<optgroup>`s — `"Detected on this page — Cyrillic"` (bul/rus/ukr), `"Installed"` (eng), `"All languages — 125"` (14 more languages, see §5) — plus a pill chip showing pack status (`packChipLabel`).
   - **Run**: a right-aligned hint span (`runNote`) and the Run button (`runLabel`/`runIcon`).
3. **Language pack row** (line 122) — wrapped in `<sc-if value="{{ showPackRow }}">`, so it appears/disappears entirely (not just hidden); not sticky. See §5.
4. **Main content row** (line 141) — `display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;padding:14px 16px 96px` (96px bottom padding clears the sticky commit bar). Two children:
   - **"The page" image pane** (line 143): `flex:1 1 300px;min-width:280px;max-width:440px;align-self:stretch;position:sticky;top:62px` — sticky within the content row, offset by the controls-row height.
   - **Cards wrapper** (line 188): `flex:2 1 470px;min-width:280px;display:flex;flex-wrap:wrap;gap:14px;align-items:stretch`, containing the Tesseract card and Surya card, each `flex:1 1 300px;min-width:280px`.
5. **Commit bar** (line 311) — `position:sticky;bottom:0;z-index:20`, `background:{{ barBg }}`, `backdrop-filter:blur(12px)`. See §9.

**Responsive rules: there are none.** A full-text search of the file for `@media` returns zero matches. There are no breakpoints anywhere. All adaptive behavior comes from CSS flexbox alone:
- Every row-level container uses `flex-wrap:wrap` (15 occurrences of `flex-wrap` in the file), so rows wrap onto new lines under width pressure rather than switching layouts at a breakpoint.
- The image pane and the two engine cards use `flex-basis`/`min-width`/`max-width` (`flex:1 1 300px;min-width:280px;max-width:440px` for the image pane; `flex:1 1 300px;min-width:280px` for each card; `flex:2 1 470px;min-width:280px` for the cards wrapper) so the three-column desktop layout collapses to a single stacked column once available width drops below roughly 280–300px per item, purely through flex-basis math, not a media query.
- The only two `position:sticky` declarations that depend on scroll are the header (`top:0`) and the commit bar (`bottom:0`); the image pane's stickiness (`top:62px`) is relative to the page, not the viewport size.

If the engineer needs actual responsive/mobile behavior (e.g. a narrow-viewport layout), it is not designed here — the mock relies entirely on wrap-and-shrink flex behavior with no distinct narrow-screen treatment.

---

## 2. Every distinct UI state

States are driven by top-level `state` fields: `demo`, `cond`, `tStarted/tSim`, `sStarted/sSim/stopped/stopAt`, `dling/dl/justInstalled/offline`, `chosen`, `overlay`, `loupe`, `lang/installed`.

### 2a. The seven "Demo" presets (prototype-only selector, header line 56–63)
These are canvas-mock conveniences to jump between states, not shipped UI, but they enumerate every state the mock supports:
- `value="fresh"` → `"p.47 photographed · pack missing"` — nothing run, `bul` pack not installed.
- `value="installed"` → `"p.47 photographed · pack installed"` — nothing run, pack present.
- `value="offline"` → `"p.47 · no network"` — nothing run, `offline:true`, pack missing.
- `value="running"` → `"p.47 · Surya mid-run"` — Tesseract done, Surya at `sSim:34` of `70.4`.
- `value="done"` → `"p.47 · both finished"` — the `photo`/clustered condition, both engines finished.
- `value="faint"` → `"p.112 faint flat scan · both finished"` — the `faint`/scattered condition, both finished.
- `value="clean"` → `"p.9 clean scan · both finished"` — the `clean` condition, both finished.

### 2b. Tesseract card states (mutually exclusive, gated in this order by `blocked` then `tStarted`/`tSim`)
- **Blocked (no language pack)** — `tessBlocked` true when `!installed` (`blocked = !installed`). Body copy (line 217): `"Tesseract can't read this page without the "` + **langName** (bold) + `" pack. Surya needs no language data and can run on its own."` Chip text: `"needs " + langName`. Preceded by icon `ph-download-simple`.
- **Idle / not run** — `tessIdle` = `!blocked && !s.tStarted`. Body (line 221): `"Not run yet. This pane fills in within seconds of pressing Run."` Chip: `"not run"`.
- **Working** — `tessWorking` = `s.tStarted && !blocked && s.tSim < c.tess`. Body (line 224): `"Reading page " + page + "…"`. Chip: `"reading"` with a pulsing dot (see §4 shimmer). A 3px progress bar fills under the meta grid.
- **Done** — `tessDone` = `s.tStarted && !blocked && s.tSim >= c.tess`. Chip: `"done in " + c.tess + "s"`. Shows the confidence meta row and the transcribed lines with low-confidence shading (see §4).

There is no explicit "Tesseract errored" state (OCR failure, corrupt image, etc.) — only "blocked by missing pack", "idle", "working", "done".

### 2c. Surya card states
- **Offer / not started** — `suryaOffer` = `(!s.sStarted && !s.stopped) || (s.stopped && suryaCount === 0)`. Shows `suryaOfferText` (four variants, all computed from whether Tesseract is done and the `spread` diagnosis — see §4/§8) and a Run button labelled `"Run Surya on page " + page + " · " + dur(surya)`, plus the fixed line `"It never starts on its own — a minute of your GPU is not something to spend by accident."`
- **Warming** — `suryaWarming` = `suryaWorking && suryaCount === 0` (i.e. started but no line has streamed in yet). Body (line 296): `"Loading the recognition model — the first line takes the longest."`
- **Working / streaming** — `suryaWorking` = `s.sStarted && !s.stopped && !suryaDone`. Streams lines as they complete (see §4) with a shimmer placeholder for the line in flight, plus a meter line and a **Stop** button.
- **Stopped** — `s.stopped`. Meter text is one of two variants depending on whether any line had streamed in before stop (see §4/§9). Shows a **"Run Surya again"** button (`ph-arrow-clockwise`) instead of Stop.
- **Done** — `suryaDone` = `s.sStarted && !s.stopped && s.sSim >= c.surya`. Chip: `"done in " + Math.round(c.surya) + "s"`. Meter text: `LINES.length + " lines · " + Math.round(c.surya) + "s · nothing dropped"`. Footer shows the "no confidence figure" line (§4).

No explicit Surya error/failure state exists either.

### 2d. Language pack row states (`showPackRow = !installed || s.dling || s.justInstalled`)
- **Needs download** (`!s.dling && !s.justInstalled && !s.offline`) — accent-tinted row, icon `ph-download-simple`, title `langName + ", " + size + "."`, body `"Tesseract needs a data pack per language. The app ships English only, so this one is a download."`, with a Download button.
- **Downloading** (`s.dling`) — same tint, title `"Downloading " + langName + "…"`, body `"It lands in the same folder as the shipped packs; the run can start the moment it finishes."`, replaced by a progress bar + `dlLabel` (`"NN% of X MB"`) instead of the button.
- **Offline** (`s.offline`, only reachable via the `offline` demo preset with the pack not installed) — muted tint, icon `ph-wifi-slash`, title `"No network."`, body `langName + " (" + size + ") can't be fetched right now. Surya needs no language data, so it can still read this page."` Download button is present but disabled.
- **Just installed** (`s.justInstalled`, transient after a simulated download completes) — success tint, icon `ph-check-circle`, title `langName + " installed."`, body `"Selected and ready — run the page now, without closing anything."`

### 2e. Low-confidence overlay toggle
- `ovIcon`: `ph-eye` when shaded/on, `ph-eye-slash` when off. Label: `tessDone ? "Where Tesseract doubted · " + c.low : "Where Tesseract doubted"`. Disabled (opacity .5, `cursor:not-allowed`) until Tesseract is done.

### 2f. The three callout ("evidence") states — `showEvidence = tessDone`, keyed on `c.spread`
1. **`"clustered"`** (the `photo` condition, edge-damage case) — bg `var(--warning-bg)`, icon `ph-scan`. Head: `"All " + low + " doubted words fall in the rightmost " + band + "% of the page."` Body: `"One band, not scattered — and every one of them is a line's last word. That is the edge that curled away from the lens, which is what Tesseract loses on a photographed page and what Surya reads in context."`
2. **`"scattered"`** (the `faint` condition) — bg `var(--bg-subtle)`, icon `ph-dots-nine`. Head: `"The " + low + " doubted words are spread across the page, not banded at an edge."` Body: `"So nothing here says this page was photographed — faint print, an unfamiliar face or an archaic orthography does the same. Surya may still read it better, but this is not the case it was added for: compare the two results yourself before spending the time."`
3. **`"clean"`** (the `clean` condition) — bg `var(--success-bg)`, icon `ph-check-circle`. Head: `"Nothing to report on this page."` Body: `conf + "% average confidence and " + low + " doubted words, neither banded nor spread. Tesseract read it cleanly, so the slower engine would cost " + dur(surya*312) + " and give you paragraph-level read-along instead of word-level."`

All three states exist and are reachable via the `photo`/`faint`/`clean` demo presets respectively — this addresses the reviewer's item #2 (the "second and third state" of the callout are present in this version of the file, contrary to the review's original concern about an earlier version).

### 2g. Commit bar states
- **Nothing chosen** (`!s.chosen`): near-opaque card-tint bg, icon `ph-info`. Title: `"Nothing is committed yet."` Body: `"Choosing an engine here saves it on the book — all " + 312 + " pages, and every extraction after this one. Whole-book times are extrapolated from the page you sampled, so a different page gives different numbers."`
- **Chosen** (`s.chosen === "tesseract" | "surya"`): `var(--bg-selected)` bg, icon `ph-check-circle`. Title: `(chosen==="tesseract"?"Tesseract":"Surya") + " is set on Първото стъпало."` Body (Tesseract): `"All " + 312 + " pages at the rate page " + page + " ran — " + tessTotal + " — and read-along will mark words. Saved on the book: every extraction from now on uses it until you change it."` Body (Surya): same shape but `"...and read-along will mark a paragraph at a time. Saved..."`. A **Change** button appears (clears `chosen`).

### 2h. Missing states worth flagging
- No error/failure state for either engine (crash, timeout, unreadable image).
- No state for "language pack corrupt/needs re-download."
- No narrow-viewport-specific layout (see §1).
- The "Demo" selector and its 7 presets are prototype scaffolding only, not shipped UI — flag if the engineer might mistake it for a real control.

---

## 3. The page image pane

**Header** (line 144): `"The page"` + faint meta `"page " + page + " · rendered at 300 dpi, grayscale"`. Sub-line (line 148, `max-width:44ch`): `"Ground truth. Neither transcription can be judged without it."`

**Image simulation** (line 149–159): a scroll container (`overflow:auto`, dark surround `background:light-dark(oklch(.42 .012 62),#100e0a)`) holding a simulated "page": `width:max-content;max-width:100%;margin:0 auto;transform:rotate(-.4deg);box-shadow:0 14px 34px rgb(0 0 0/45%),18px 0 26px -14px rgb(30 22 10/55%)`, with `background:linear-gradient(104deg,#f5eee2 0%,#f1e9dc 48%,#e0d5c1 80%,#c9bda5 100%)` standing in for a scanned page's uneven lighting/toning. Content: a running-header line (`"първото стъпало"` left, page number right, uppercase, letter-spaced, `#6d6353`), then an `sc-for` over `facLines` rendering each mock line as spans (see §3 overlay). Two absolutely-positioned overlays sit on top: a decorative vignette gradient (`pointer-events:none`), and an invisible `onMouseMove`/`onMouseLeave` layer that drives the loupe (`cursor:crosshair`, its own faint radial-gradient sheen).

**Low-confidence overlay (markup + CSS)**: each rendered text segment is `<span style="background:{{ s.bg }};box-shadow:{{ s.ring }};border-radius:2px">{{ s.t }}</span>`. `segsFor()` (line 410) builds these: a "good" segment has `bg:"transparent"`, `ring:"none"`; a "bad" (low-confidence) segment, only when `shade` is true (`shade = s.overlay && tessDone`), gets `bg:"var(--lowconf)"`, `ring:"0 0 0 1px var(--lowconf-ring)"`. So the shading is literally a background tint + 1px inset ring via `box-shadow`, applied per-word span, toggled by the eye/eye-slash button. In `"tail"` mode (the `photo` condition) exactly one trailing word per line is marked bad; in the other modes a `doubt` list of `[lineIndex, tokenIndex]` pairs picks the bad token per line.

**Loupe/magnifier**: markup at line 160–171, gated by `<sc-if value="{{ loupeOn }}">` (`loupeOn = !!s.loupe`). It is a `position:fixed` circle: `width:176px;height:176px;border-radius:99px;overflow:hidden;pointer-events:none;z-index:6`, styled `background:#f1e9dc;box-shadow:0 10px 28px rgb(0 0 0/50%),0 0 0 1px rgb(255 255 255/24%),inset 0 0 14px rgb(40 32 18/14%)`. Inside it, an absolutely-positioned re-render of the *entire* page markup (header line + `facLines`) at `transform:scale(1.9);transform-origin:0 0`, offset by `left:{{ loupeInnerX }};top:{{ loupeInnerY }}`.

JS driving it (`loupeMove`, line 627): on `mousemove` over the invisible hit layer, it reads the parent page element's `getBoundingClientRect()`, clamps the pointer position to `[0, offsetWidth]`×`[0, offsetHeight]` as `px`/`py`, and stores `{x: e.clientX, y: e.clientY, px, py, w: pg.offsetWidth}` in `state.loupe`. `loupeOut` clears it on `mouseleave`. Render-time math:
- `loupeLeft = (loupe.x - 88) + "px"`, `loupeTop = (loupe.y - 88) + "px"` — centers the 176px circle on the cursor.
- `loupeInnerX = (88 - loupe.px * 1.9) + "px"`, `loupeInnerY = (88 - loupe.py * 1.9) + "px"` — shifts the 1.9x-scaled inner copy so the point under the cursor stays under the circle's center.
- `loupeW = (loupe.w) + "px"` — the inner copy's width is pinned to the real page's rendered width so the 1.9x scale reads consistently regardless of zoom/scroll.
Note: 1.9 appears both as the `transform:scale(1.9)` in the markup and in the `loupeInnerX/Y` formula — the review's "2.4x" figure does not match this reading of the current file; the file itself is internally consistent at **1.9x**.

**Callout under the image**: the `showEvidence` block at line 180–185, exact structure `<i class="ph {{evIcon}}">` + `<span><strong>{{evHead}}</strong> {{evBody}}</span>`. The three exact sentence pairs are quoted in full in §2f above.

Footer row above the callout (line 173–179): the overlay toggle button (`ovLabel`: `"Where Tesseract doubted"` / `"Where Tesseract doubted · " + low`), a spacer, and a static hint `<i class="ph ph-magnifying-glass">` + `"Hover to magnify"`.

---

## 4. Tesseract card and Surya card

### Tesseract card (line 190–244)
- **Header**: `"Tesseract"` (bold, 13px) + a pill chip. Chip background/color come from state (`idle`/`work`/`done`/blocked palettes); chip text is one of `"needs " + langName`, `"reading"`, `"done in " + c.tess + "s"`, `"not run"`. When `tessWorking`, a `<span>` pulsing dot (`animation:pulse-dot 1.15s ease-in-out infinite`, keyframes at line 41: `0%,100%{opacity:1}50%{opacity:.28}`) precedes the chip text.
- **Meta grid** (line 196, `display:grid;grid-template-columns:auto 1fr;gap:3px 10px`): four label/value rows —
  - `"Speed"` → `tessDone ? c.tess + "s on page " + page + ", measured" : "about a second a clean page, longer on a damaged one"`
  - `"Read-along"` → static `"word by word"`
  - `"Damaged page"` → static `"degrades — margins first"`
  - `"This book"` → `tessDone ? tessTotal + " for " + 312 + " pages at this rate" : "minutes, not hours"` (this is the "Tesseract never states its own whole-book total" the review flagged — it does, in this field, once done; before done it only says the vague `"minutes, not hours"`).
- **Working-state progress bar** (line 202–204): 3px bar, `background:var(--bg-subtle)` track, fill `background:var(--badge-extracting-text)`, `width:{{ tessBarW }}` = `Math.min(100, Math.round((tSim/c.tess)*100)) + "%"`. No shimmer/gradient animation on this bar — it is a plain deterministic fill, unlike Surya's streaming placeholder.
- **Confidence meta row**, only when `tessDone` (line 205–212): `"Average confidence"` label, big number `confPct` (`c.conf + "%"`, colored `var(--success-text)` when clean else `var(--warning-text)`), a thin progress bar filled to that percentage, and a legend swatch (`11×11px`, `background:var(--lowconf)`, `box-shadow:0 0 0 1px var(--lowconf-ring)`) + `confLow` text = `low + " of " + words + " words scored under 60%"`.
- **Body**: three mutually exclusive `sc-if` blocks for blocked/idle/working (plain text, quoted in §2b) and a `tessDone` block rendering `tessLines` — each line is a row-number span (`10px`, tabular-nums, right-aligned in a 17px column) + the shaded-span text (same `segsFor` structure as the image pane, always `shade:true` for this pane regardless of the overlay toggle — i.e. the card itself always shows its own doubt-shading; only the *page image* overlay is togglable).
- **Footer** (line 237–243): when done, a fixed note `"Shaded words are the ones Tesseract itself scored under 60% — its own doubt, not our judgement."` (`max-width:32ch`), then a spacer, then the **"Use Tesseract for this book"** / **"Using Tesseract"** pick button (`ph-circle` / `ph-check-circle`), disabled until done.

### Surya card (line 246–306)
- **Header**: `"Surya"` + chip, same shimmer-dot pattern while working. Chip text: `"reading"` / `"done in " + Math.round(c.surya) + "s"` / `"stopped"` / `"not run"`.
- **Meta grid**: same four rows —
  - `"Speed"` → `suryaDone ? Math.round(c.surya) + "s on page " + page + ", measured" : "roughly ten times slower — about a minute a page"`
  - `"Read-along"` → static `"a paragraph at a time"`
  - `"Damaged page"` → static `"still accurate"`
  - `"This book"` → `suryaDone ? suryaTotal + " for " + 312 + " pages at this rate" : "hours — " + suryaTotal` (Surya's whole-book number is shown even before it's done, unlike Tesseract's vague pre-done copy — confirming the review's observation of the asymmetry).
- **Working progress bar**: same 3px bar pattern, fill color `var(--accent)` (vs Tesseract's `var(--badge-extracting-text)`).
- **Meter row**, shown whenever `sStarted || stopped` (line 261–268): text is `suryaMeterText` (four variants, see below) plus, while working, an inline **Stop** button (plain text link style), or while stopped, a **"Run Surya again"** pill button.
- **Streaming shimmer markup** (line 279–293): `suryaHasLines = suryaCount > 0` renders completed lines (`suryaLines`, row-number + plain text, no per-word shading — Surya has no per-word confidence to shade). While `suryaWorking`, one extra placeholder row is appended for the line in flight:
  ```html
  <div style="display:flex;gap:9px;margin-top:2px">
    <span style="...">{{ suryaNextN }}</span>
    <span style="flex:1;min-width:0;height:15px;margin-top:4px;border-radius:3px;background:var(--bg-subtle);overflow:hidden;position:relative">
      <span style="position:absolute;inset:0;width:30%;background:linear-gradient(90deg,transparent,var(--accent-subtle),transparent);animation:slide-indeterminate 1.5s linear infinite"></span>
    </span>
  </div>
  ```
  Keyframes (line 42): `slide-indeterminate { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }` — a translucent band sweeps left-to-right across a 15px-tall bar standing in for the not-yet-arrived line.
- **`suryaWarming`** block (before any line streams in): `"Loading the recognition model — the first line takes the longest."`
- **`suryaOffer`** block (not started, or stopped with zero lines): `suryaOfferText` (4 variants) + a Run/CTA button labelled `"Run Surya on page " + page + " · " + dur(c.surya)` + the fixed line `"It never starts on its own — a minute of your GPU is not something to spend by accident."`
- **Progress format** — exact string, `suryaMeterText` when actively working (line 695): `"Line " + Math.max(1, suryaCount) + " of " + LINES.length + " · " + Math.round(s.sSim) + "s elapsed · about " + Math.max(1, Math.round(c.surya - s.sSim)) + "s left"` — this produces the reviewer-quoted `"Line 8 of 22 · 34s elapsed · about 36s left"` shape. Other `suryaMeterText` variants: done → `LINES.length + " lines · " + round(c.surya) + "s · nothing dropped"`; stopped with lines → `"Stopped at line " + suryaCount + " of " + LINES.length + ". Tesseract's result is untouched."`; stopped with zero lines → `"Stopped before the first line came back — nothing to show. Tesseract's result is untouched."`
- **Footer**: when done, the fixed note `"No confidence figure: Surya reports none, so there is nothing to compare against " + confPct + "."` (`max-width:30ch`), then the **"Use Surya for this book"** / **"Using Surya"** pick button.

`LINES.length` is 22 (see §8), matching the reviewer's "Line 8 of 22" example.

---

## 5. Language pack row

**Language `<select>` structure** (controls row, line 83–108): a single `<select>` with three `<optgroup>`s:
1. `label="Detected on this page — Cyrillic"`: `bul` (`Bulgarian{{ bulTail }}`), `rus` (`Russian{{ rusTail }}`), `ukr` (`Ukrainian{{ ukrTail }}`) — tails are computed per-option as `" — installed"` or `" — " + size + " to download"` depending on `s.installed`.
2. `label="Installed"`: one static option, `English — installed`.
3. `label="All languages — 125"`: 14 static options, each `"<Name> — <size>"`: `French — 4.0 MB`, `Hebrew — 3.7 MB`, `Turkish — 7.5 MB`, `German — 8.6 MB`, `Italian — 8.9 MB`, `Greek — 8.9 MB`, `Serbian — 9.3 MB`, `Polish — 12.0 MB`, `Hindi — 11.9 MB`, `Arabic — 12.6 MB`, `Korean — 12.5 MB`, `Chinese, Simplified — 13.1 MB`, `Spanish — 13.6 MB`, `Japanese — 14.3 MB`.

Beside the select, a pill chip (`packChipLabel`): `"pack installed"` / `"pack missing · offline"` / `"pack not installed · " + size`.

**The pack row itself** (line 122–139) is wrapped in `<sc-if value="{{ showPackRow }}">` — it is not merely hidden via CSS, the whole block is conditionally present, appearing/disappearing per `showPackRow = !installed || s.dling || s.justInstalled`. Structure: an icon, a `<strong>` title + body sentence (both computed, quoted in §2d), a flex spacer, then either a download-progress mini-bar (`dling`) or a Download button (`showDlBtn = !s.dling && !installed`) labelled `"Download " + langName + " · " + size`.

---

## 6. CSS custom properties

All properties referenced in the mock (declared at lines 11–38, or used from an implied base):

`--stack-sans`, `--stack-display`, `--stack-reading`, `--bg-page`, `--bg-card`, `--bg-subtle`, `--bg-selected`, `--border`, `--border-input`, `--text-primary`, `--text-secondary`, `--text-muted`, `--text-faint`, `--accent`, `--accent-hover`, `--accent-text`, `--accent-subtle`, `--on-accent`, `--success-text`, `--success-bg`, `--warning-text`, `--warning-bg`, `--badge-extracting-bg`, `--badge-extracting-text`, `--lowconf`, `--lowconf-ring`.

Grep of `packages/web/src/styles.css`:

| token | in styles.css? | notes |
|---|---|---|
| `--stack-sans` | yes (line 162) | |
| `--stack-display` | yes (line 163) | |
| `--stack-reading` | yes (line 164) | |
| `--bg-page` | yes (line 167) | |
| `--bg-card` | yes (line 168) | |
| `--bg-subtle` | yes (line 170) | |
| `--bg-selected` | yes (line 173) | |
| `--border` | yes (line 175) | |
| `--border-input` | yes (line 176) | |
| `--text-primary` | yes (line 179) | |
| `--text-secondary` | yes (line 180) | |
| `--text-muted` | yes (line 182) | |
| `--text-faint` | yes (line 183) | |
| `--accent` | yes (line 186) | |
| `--accent-hover` | yes (line 187) | |
| `--accent-text` | yes (line 188) | |
| `--accent-subtle` | yes (line 190) | |
| `--on-accent` | yes (line 194) | |
| `--success-text` | yes (line 209) | |
| `--success-bg` | yes (line 207) | |
| `--warning-text` | yes (line 215) | |
| `--warning-bg` | yes (line 213) | |
| `--badge-extracting-bg` | yes (line 251) | |
| `--badge-extracting-text` | yes (line 252) | |
| `--lowconf` | **no** | not present in styles.css — new token, as the review says |
| `--lowconf-ring` | **no** | not present in styles.css — new token, as the review says |

The `--badge-extract-bg` / `--badge-extract-text` names the review warned about **do not appear anywhere in this version of the mock file** — the file already uses `--badge-extracting-bg` / `--badge-extracting-text`, which do exist in styles.css. That correction from the review appears to already be applied.

---

## 7. Icons

Exact `ph ph-…` / `ph {{ dynamicIcon }}` classes found in the file, with their Phosphor icon name and whether `packages/web/src/components/icons.tsx` re-exports them:

| `ph-` class | Phosphor component name | in icons.tsx? | exported as |
|---|---|---|---|
| `ph-arrow-left` | `ArrowLeft` | yes | `IconArrowLeft` |
| `ph-moon` | `Moon` | yes | `IconThemeDark` |
| `ph-sun` | `Sun` | yes | `IconThemeLight` |
| `ph-minus` | `Minus` | **no** | — |
| `ph-plus` | `Plus` | yes | `IconAdd` |
| `ph-download-simple` | `DownloadSimple` | yes | `IconDownload` |
| `ph-check` | `Check` | yes | `IconCheck` |
| `ph-wifi-slash` | `WifiSlash` | **no** | — |
| `ph-magnifying-glass` | `MagnifyingGlass` | yes | `IconSearch` |
| `ph-eye` | `Eye` | **no** | — |
| `ph-eye-slash` | `EyeSlash` | **no** | — |
| `ph-scan` | `Scan` | **no** | — |
| `ph-dots-nine` | `DotsNine` | **no** | — |
| `ph-check-circle` | `CheckCircle` | **no** (only plain `Check` is exported, as `IconCheck`; `CheckCircle` is a distinct Phosphor glyph) | — |
| `ph-arrow-clockwise` | `ArrowClockwise` (singular-arrow "refresh" glyph) | **no** — `icons.tsx` exports `ArrowsClockwise` (plural-arrow glyph) as `IconRefresh`, which is a different icon from `ArrowClockwise`; do not conflate them | — |
| `ph-play` | `Play` | yes | `IconPlay` |
| `ph-circle` | `Circle` | **no** | — |
| `ph-info` | `Info` | **no** | — |
| `ph-arrow-u-up-left` | `ArrowUUpLeft` | **no** | — |

Summary: of 19 distinct icon glyphs used, 7 (`ArrowLeft`, `Moon`, `Sun`, `Plus`, `DownloadSimple`, `Check`, `MagnifyingGlass`, `Play` — 8 actually) already have re-exports; the remaining 11 (`Minus`, `WifiSlash`, `Eye`, `EyeSlash`, `Scan`, `DotsNine`, `CheckCircle`, `ArrowClockwise`, `Circle`, `Info`, `ArrowUUpLeft`) need to be added to `icons.tsx` per its own header comment ("Need one that is not here? Find it at phosphoricons.com and add a line"). This matches the review's "Icons are fine... naming them in that module is a build step" note — none require a redesign, but roughly half the set is net-new to the file.

---

## 8. JavaScript behaviour

**Top-level constants** (exact):
```js
const WARM = 3.2;
const PAGES = 312;
```
There are **no** module-level constants literally named `TESS_AT` or `SURYA_TOTAL` in this version of the file — those names (and the review's cited value `TESS_AT = 1.9`) do not appear anywhere in the current markup/script. Per-page timing instead lives inside a `COND` object, keyed by page condition:
```js
const COND = {
  photo: { page: 47, mode: "tail", spread: "clustered", tess: 8.7, surya: 70.4, conf: 71, low: 16, words: 214, band: 18 },
  faint: { page: 112, mode: "spots", spread: "scattered", tess: 6.4, surya: 66, conf: 78, low: 11, words: 196,
    doubt: [[0,3],[1,1],[3,4],[5,2],[7,5],[9,0],[11,3],[13,6],[15,1],[17,4],[19,2]] },
  clean: { page: 9, mode: "spots", spread: "clean", tess: 2.1, surya: 58, conf: 96, low: 2, words: 231,
    doubt: [[6,4],[16,2]] },
};
```
So `photo.tess = 8.7` matches the review's "Tesseract took 8.7s on that same photographed page," and `photo.surya = 70.4` matches the review's `SURYA_TOTAL`. The review's `TESS_AT = 1.9` does not correspond to any value currently in the file (closest is `clean.tess = 2.1`); this may reflect an intermediate edit made after the review was written, or the review may be describing a different constant that was since removed/renamed. Flagging this discrepancy rather than guessing.

**Language pack sizes** — a `LANGS` object (line 381–400) with `{name, size}` per code; 18 entries total (`bul`, `rus`, `ukr`, `eng`, `fra`, `deu`, `spa`, `ita`, `ell`, `srp`, `pol`, `tur`, `ara`, `heb`, `hin`, `jpn`, `kor`, `chi_sim`). These sizes match the "actual" column in the review's correction table (e.g. `spa: "13.6 MB"`, `ita: "8.9 MB"`, `chi_sim: "13.1 MB"`), confirming the sizes were already corrected in this version of the file. One deviation: `rus` is `"15.3 MB"` here vs. the brief's `bul`/`rus`/etc. reference set — not itemized in the review's table (which covered only the 13 previously-wrong entries), so no conflict, just noting it wasn't in the reviewed set either.

**Timer / simulated streaming** (`componentDidMount`, line 444): `setInterval(() => this.tick(), 100)` — a 100ms tick.
```js
tick() {
  ... 
  if (s.dling) { const dl = Math.min(100, s.dl + 3.6); ... }               // download simulation
  if (s.tStarted && s.tSim < c.tess) patch.tSim = Math.min(c.tess, s.tSim + 0.1 * this.speed);   // Tesseract sim
  if (s.sStarted && !s.stopped && s.sSim < c.surya) patch.sSim = Math.min(c.surya, s.sSim + 0.1 * this.speed); // Surya sim
}
```
`this.speed = this.props.demoSpeed ?? 6` — a canvas-editable prop (range 1–12×, default 6) that accelerates the simulated elapsed time for demo purposes; each 100ms tick advances simulated seconds by `0.1 * speed`. Download simulation advances a flat `3.6` percentage points per tick regardless of `speed` (~2.8s to finish at 100ms/tick).

**Mock data array `LINES`** (line 329–352): 22 entries (`LINES.length === 22`, matching "Line 8 of 22"), each shaped:
```js
{ h: "<line prefix, Bulgarian text>", t: "<the doubted trailing word, or ''>", g: "<a garbled/OCR-mangled version of t>" }
```
9 of the 22 entries have `t: "", g: ""` (no doubted word on that line — used to vary rhythm; those lines are always rendered "clean" in `"tail"` mode).

**Garbling**: a `SUB` substitution map (Cyrillic → visually-similar Latin/lookalike glyphs, e.g. `"о":"0", "и":"н", "е":"e", "а":"a", "с":"c", "у":"y", "р":"p", "х":"x", "ъ":"ь"`) and `garble(w)` (line 355) which replaces the **first two** substitutable characters in a word, in order, leaving the rest untouched — simulating OCR misreads for the Tesseract card only (`garbled=true` is passed for `tessLines`, `false` for the page-image `facLines`, i.e. the ground-truth image pane always shows correct text; only Tesseract's own output pane shows the garbled reading).

**How low-confidence words are chosen** (`segsFor`, line 410–434):
- `mode: "tail"` (the `photo` condition): if the line has a trailing word (`l.t` truthy), that single trailing word is marked bad; every other line is entirely "good." This is what produces the "clustered at the right edge / last word of the line" pattern the review discusses in its item 2b.
- `mode: "spots"` (`faint`, `clean`): looked up per-line in `cond.doubt`, an array of `[lineIndex, tokenIndex]` pairs; the token at that index within the line's whitespace-split token list is marked bad, the rest of the line good. Lines with no matching entry are entirely good.

**Commit-bar estimate formulas** (quoted exactly):
```js
function dur(sec) {
  if (sec < 90) return Math.round(sec) + "s";
  if (sec < 5400) return "about " + Math.round(sec / 60) + " min";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec - h * 3600) / 60);
  return "about " + h + "h " + (m ? m + "m" : "00m");
}
...
const tessTotal = dur(c.tess * PAGES);
const suryaTotal = dur(c.surya * PAGES);
```
So both whole-book estimates are a flat linear extrapolation: **per-page measured time × 312**, run through `dur()` for formatting. For `photo`: `tess 8.7 × 312 = 2714.4s` → `"about 45 min"`; `surya 70.4 × 312 = 21964.8s = 6.1h` → `"about 6h 06m"` (matches the review's "312 × 70.4s = 6.1 hours" check). No other smoothing, averaging across sampled pages, or confidence interval is computed — it is a single-page-rate × page-count multiplication, which is exactly the fragility the review's item 3 raises.

**Surya line-count-from-elapsed-time math** (line 491–493, drives how many "completed" lines show while streaming):
```js
const per = (c.surya - WARM) / LINES.length;
const rawCount = Math.max(0, Math.floor((s.sSim - WARM) / per));
const suryaCount = s.stopped ? Math.min(s.stopAt, LINES.length) : Math.min(rawCount, LINES.length);
```
i.e. the first `WARM` (3.2s) of simulated elapsed time produces zero completed lines (the "warming" state), then lines complete at a constant rate `(surya - WARM) / 22` seconds apiece.

---

## 9. All visible copy strings — commit bar, both card headers, header/back link

**Header/back link region:**
- `"Първото стъпало"` (back link text, next to `ph-arrow-left`)
- `"Try one page"` (`<h1>`)
- `"1 file · 312 pages · no text layer"`
- `"Demo"` (prototype-only label)
- Toggle button `title="Light / dark"` / `aria-label="Toggle appearance"`

**Commit bar** (both variants fully quoted in §2g):
- Uncommitted: `"Nothing is committed yet."` / `"Choosing an engine here saves it on the book — all 312 pages, and every extraction after this one. Whole-book times are extrapolated from the page you sampled, so a different page gives different numbers."`
- Committed (Tesseract): `"Tesseract is set on Първото стъпало."` / `"All 312 pages at the rate page <n> ran — <tessTotal> — and read-along will mark words. Saved on the book: every extraction from now on uses it until you change it."`
- Committed (Surya): `"Surya is set on Първото стъпало."` / `"All 312 pages at the rate page <n> ran — <suryaTotal> — and read-along will mark a paragraph at a time. Saved on the book: every extraction from now on uses it until you change it."`
- Buttons: `"Change"` (only when chosen); `"Back to Extract"` (chosen) / `"Cancel"` (not chosen), with `title`s: `"Returns to the Extract dialog with your other settings as you left them; the engine is already saved"` / `"...no engine is saved"`.

**Tesseract card header**: `"Tesseract"` + chip text (`"needs <lang>"` / `"reading"` / `"done in <n>s"` / `"not run"`).

**Surya card header**: `"Surya"` + chip text (`"reading"` / `"done in <n>s"` / `"stopped"` / `"not run"`).

(All other card copy — meta rows, footers, body states, callouts — is quoted in full in §2 and §4 above; not re-duplicated here.)

---

## 10. Fonts and external resources

Declared in `<helmet>` (line 10), i.e. loaded via `<link>` tags — **these cannot be used as-is in the real app**, per the review's implementation note and the general constraint that the shipped app cannot load external stylesheets:

1. `https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap` — Google Fonts stylesheet, pulling **Fraunces** (weight 600 only, optical-size axis 9–144 — used for `--stack-display`, the `<h1>` and card headers) and **Source Serif 4** (weights 400/600, optical-size 8–60 — used for `--stack-reading`, the page-image and transcript body text).
2. `https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css` — the Phosphor **web/CSS** icon package (the `ph ph-*` class-based icon font/CSS this mock uses throughout). The real app already uses `@phosphor-icons/react` (per `icons.tsx`), a different distribution of the same icon set (React SVG components, not a CSS icon font) — so the icon *names* transfer (mapped in §7) but the delivery mechanism does not; nothing here can be loaded verbatim.

No other external resources (no separate web fonts beyond these two families, no other CDN scripts) are referenced. `--stack-sans` uses only system fonts (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` — no external load needed for that stack).

---

## Overview (5 lines)

Full-screen (not modal) OCR trial page with a sticky header, a controls row, a conditionally-rendered language-pack row, a two-pane body (sticky page-image preview + Tesseract/Surya card pair), and a sticky commit bar — laid out entirely with wrapping flexbox and zero `@media` breakpoints. All three callout states (clustered/scattered/clean) the review asked for are present with exact copy, as are the blocked/idle/working/done states for each engine and the four pack-row states; no error states exist for either engine. `--lowconf`/`--lowconf-ring` are genuinely new tokens (not in `styles.css`); the review's `--badge-extract-*` naming concern is already resolved in this file version. Roughly half of the 19 Phosphor icons used are not yet re-exported in `icons.tsx` (notably `ArrowClockwise`, distinct from the already-exported `ArrowsClockwise`/`IconRefresh`). The file's JS backs every number shown: whole-book estimates are a flat `perPageTime × 312` through a `dur()` formatter, language-pack sizes match the review's corrected table, and no `TESS_AT`/`SURYA_TOTAL` constants exist under those names in this version — timings live in a `COND` object instead, with `photo.tess = 8.7` (not the review's cited `1.9`).
