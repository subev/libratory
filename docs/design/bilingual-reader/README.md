# Handoff: Bilingual reading (web reader)

## Overview
Read a chapter alongside its translation, listen to either narration, and inspect the words or expressions that correspond. Responds to `docs/two-languages-design-brief.md`. The standalone reader (`packages/web/src/pages/Reader.tsx`) is the main target. The chapter modal gets one contextual link. Chapters and Outputs are annotated only (later).

## About the design files
`Bilingual Reader.dc.html` is a **design reference built in HTML**, not production code. Open it in a browser (keep `support.js` next to it). It is a pan/zoom board with numbered artboards 01–08. Rebuild in the existing web app using its components (`Button`, `Dropdown`, `SegmentedControl`, `StatusBadge`, `CueTranscript`, `CuePages`, `use-cue-follow`) and `packages/web/src/styles.css` tokens.

Artboard 02 is interactive:
- ▶ plays a simulated narration
- clicking a word inspects it
- Speak switches the voice
- scrolling away shows "Back to the … voice"
- Column / Text / Page and Bilingual all toggle

Tweaks: sample (en-he / bg-de), timing (word / sentence), appearance (light / dark).

## Fidelity
**High fidelity for layout, states, copy and behaviour.** Colours and type use the desktop tokens already in `styles.css`. The page crop in Column view is **simulated with live text**. In the product it is the existing PDF crop image with cue rects.

## Recommended decisions (ranked; no open alternatives)
1. **Bilingual is a toggle in the reader bar that keeps the current view.**
   - Column: page crop + translation lane. This is the default and the primary layout.
   - Text: both languages reflowed as paired passages.
   - Page: moves to Column.
2. **Rows are passages.** Each paragraph pair shares a grid row. Counterparts stay beside each other. No scroll-percentage sync.
3. **Click/tap a word = inspect, not seek.** Listening is the explicit "Listen from here" action. This is a deliberate change from tap-to-seek, and applies in bilingual mode only.
4. **One narration at a time.** Switching voice keeps the play state and lands on the corresponding sentence (details under Narration switching).
5. **Below 700px, passages stack** in reading order with the transport docked at the bottom. The translation is shown by default; "On tap" is optional.
6. **Chapter modal:** a single "Open bilingual reader" action. The embedded preview is **not recommended** for now.

⚠ **Boundary change vs brief:** the brief lists PDF-plus-translation as later. Column support was requested as a top feature, so it's in scope here. Required data: per-crop **paragraph boundaries** (y ranges within a column crop) so a crop can be split between paragraphs and aligned with translation passages. It may come from the existing cue rects or detected columns; this needs confirming.

## Screens

### 01 · Enter bilingual reading
**Reader bar.** The row order stays as in `Reader.tsx`: back · play · chapter select · speed · time · view SegmentedControl. After those, add a **Bilingual** button.
- Styling: `ph-translate` icon, 26px tall, 6px radius.
- Pressed state: `--bg-selected` background, `--accent` border, `--accent-text` label, `aria-pressed`.

**Picker.** A Dropdown, 360px wide, headed "Read {original} alongside". One row per **translation** (never a rewrite variant). Each row is the language name plus a status word:

| Status | Badge | Subline |
|---|---|---|
| Ready | success | "Paired · word links · narration in both" (reflects the data) |
| Text only | neutral | "Paired · no {lang} narration" |
| Pairing not ready | warning | Connected: link "Prepare in Chapters" (navigates only). Offline: "Not in this file", with an explanation and no action. |

- **No translation at all:** "This book has one language" + "Translate in Chapters". The link is hidden offline.
- Picking a Ready or Text-only row enables bilingual reading at the current sentence.
- Esc or an outside click closes the picker; focus returns to the button.
- The choice is remembered per book.
- Opening the reader or the picker **never starts processing**.

### 02 · Wide reading and playback (primary)
**Second bar row** (`--bg-subtle`), shown while bilingual is on:
- `READ` {original} `with` [translation ▾]
- divider
- `SPEAK` segmented control [🔊 English | Hebrew]
- spacer, then the follow status: "Following the voice" / "Paused" / "Following paused"
- The existing granularity badge stays at the end of the first row: "Word timing" / "Sentence timing".

**Column view (default)**
- Grid: `minmax(0,560px)` crop | `minmax(0,540px)` translation, gap 56px, centred.
- Sticky column headings:
  - Left: "{Lang}" (13/700) + "Column · p. 43, column 2" (12, `--text-muted`)
  - Right: "{Lang}" + "Translation · reflowed"
  - A "Speaking" capsule (`--accent-subtle` / `--accent-text`, speaker icon) marks the voice's column.
  - An RTL translation's heading aligns to the right; the UI itself stays LTR.
- Left cell: the crop slice for that paragraph. Slices sit flush, so the page reads continuously. When the translation is taller, the row grows and blank paper shows under that slice. **Never scale or cut a crop mid-line.**
- Right cell: translation in `--font-reading` 18/1.55, padding 10px 0 22px.
- Crop marks use the existing cue rects:
  - active sentence → `--cue-linked`
  - spoken word → `--cue-word`
  - clicking a word rect → inspect
- Pages without a text layer mark whole paragraphs; words there can't be inspected. The translation lane still works.

**Text view**
- Grid: `minmax(0,590px)` ×2, gap 64px. Both columns use `--font-reading` 19/1.6 with `text-wrap: pretty`. Row gap 26px.
- Measure is about 65ch. Don't widen it to fill the window.

**Marks** (never colour alone)

| Mark | Style | Token |
|---|---|---|
| Active sentence pair (both sides, only when paired) | tint | `--cue-linked` |
| Spoken word | **fill**, 3px radius | `--cue-word` |
| Spoken word's counterpart | **1.5px inset outline** | `--cue-ring` |
| Inspected word + its counterparts (incl. same-side parts of a split expression) | neutral fill + `underline solid 2px --text-primary`, offset 5px | `--insp-bg` |
| Inspected, unlinked | same, dotted underline | `--insp-bg` |
| Keyboard focus | 2px accent outline, offset 2px | `--accent` |

**Follow**
- Reuse `useFollowCue` with `READER_BAND` (top 120, bottom 140) on the **row** of the active sentence.
- A manual scroll that moves the active row out of view sets `followPaused`. Playback continues.
- A pill appears at bottom centre: "↓ Back to the {Lang} voice".
- Pressing the pill or "Listen from here" clears `followPaused` and scrolls back.
- Programmatic scrolls are ignored for about 900ms.

**Unmatched sentence being spoken:** under the other column's passage, show "No linked counterpart for the sentence being read" (12px, `--text-muted`, `ph-link-break`).

**Leaving**
- Bilingual off → the same view in one language, at the same sentence.
- Column ↔ Text keeps the pairing and the passage.

### 03 · Narrow
- **< 700px, portrait (393):** passages stack. Text: original 18px, translation 17px in `--text-secondary`, each translation labelled with its language (10.5px caps). Column: the crop is split into paragraph slices, with the translation under each slice.
- **Top bar (52px):** back · chapter title (truncated) · Bilingual icon · overflow.
- **Docked bottom transport:** progress row, then Speak segmented control (36px) · replay 15 · play (48px, `--accent` fill) · speed.
- **Translation display:** the overflow menu has "Translation: Shown / On tap". Shown is the default. On tap shows a "Show {Lang}" text button (44px) under each passage; it reveals that passage only.
- **Tap a word** → bottom sheet: grabber, language label, word 24px, counterpart 24px, and a full-width 44px "Listen from here". Dismiss with ×, swipe down, or a tap outside. Long-press is native selection.
- **≥ 700px (landscape 852):** two columns return, with safe-area side padding. A missing narration shows as a disabled "German" option with a `ph-speaker-slash` icon and a tooltip explaining why.

### 04 · Word and expression inspection
**Popover** (320px, radius 10, `--bg-card`, shadow `0 10px 30px rgb(0 0 0/18%)`), anchored 8px below the clicked word:
- Header: source language caps label, a shape caption ("1 word → 2 words", "split expression → 1 word"; hidden for 1→1), and ×.
- Source text: `--font-reading` 21px, with `lang` and `dir` set.
- Divider.
- Counterpart: language label + text. Split expressions are joined with " … ".
- Unlinked: "No linked counterpart" + "No link was found for this word. That doesn't mean it was left out." Never write "Untranslated".
- Footer: "Listen from here" (disabled as "No {Lang} narration" when that narration is missing) and a faint "Esc closes" hint.

**Cases** (all shown on the board):
- single
- one word ↔ several words (breakwater ↔ שובר הגלים, Bahnsteigkante ↔ ръба на перона)
- split expression (turned … off ↔ כיבתה, schaltete … aus ↔ изключи)
- repeated word (only the linked occurrence is marked)
- no linked counterpart

**Input matrix**

| | Mouse | Keyboard | Touch |
|---|---|---|---|
| Inspect | click without drag; hover only previews the underline | Tab to passage (one stop per column), ←/→ by word, Enter | tap → sheet |
| Listen from here | popover button; switches voice to that side; timed word, else sentence start | L in popover / Shift+Enter on focused word; Space still play/pause | 44pt sheet button |
| Select/copy | drag or double-click; a click ending a selection doesn't inspect | Shift+arrows, ⌘C | long-press |
| Dismiss | ×, outside click, clicking another word moves it | Esc (focus returns to word) | ×, swipe down, tap outside |

### 05 · Narration switching and incomplete data
**Switching voice**
- Keep the play state: playing keeps playing; paused stays paused, positioned.
- The target is the counterpart sentence, never the same timestamp or percentage.
- It lands on the linked **word** only when word timing is trustworthy. Otherwise it lands at the start of the counterpart sentence.
- Status toast: "Now speaking {Lang}, from the same sentence".

**Spoken sentence has no counterpart**
- Go to the **previous paired sentence**, or the next one if there is no previous.
- Toast: "{Lang} has no counterpart for this sentence, so it starts at the previous one".

**Chapter change**
- Keeps bilingual mode, the translation and the voice.
- A chapter without that translation opens single-language with the note "Chapter N has no {Lang} translation, so it opens in {Original} only."
- Autoplay continues in the same voice; it stops if that voice has no narration for the chapter.

**Condition matrix**

| Condition | UI |
|---|---|
| Both ready | Either voice can speak; only one plays |
| Narration missing | Voice option disabled with a reason; texts stay readable |
| Sentences paired, no word links | Sentence following only; no counterpart words drawn; clicking a word shows its sentence counterpart |
| Word links, coarse timing | Inspection works; playback highlights sentences; "Sentence timing" badge |
| Uncertain / unmatched | No tint on the other side; quiet note when spoken |
| Partial / failed batch | Keep results; one note above affected passages: "Pages 44–46 aren't linked yet. Retry in Chapters." |
| Text edited after prep | Links hidden: "Edited since pairing, so links are hidden"; both texts readable |
| Narration replaced | Links kept; only timings belonging to the new recording are used; sentence-level or off until retimed |

Raw scores, provider diagnostics and token counts are never shown in the reading flow.

### 06 · Chapter modal (`ChapterModal.tsx`)
**Placement.** Add "Open bilingual reader ↗" (secondary sm Button, `ph-translate`) immediately after the variant PillToggles. Keep it away from Re-synthesize and Translate.

**It carries**
- the chapter
- the selected translation (the active pill, or the book's last-used translation when Original is selected)
- the current passage, if a valid anchor exists

Route: `/books/:id/read?chapter=3&with=he&at=s4`. The param names are a proposal.

**Behaviour**
- The modal's narration pauses before navigation.
- The reader opens paused at that passage, in the voice that was playing.

**Disabled states**
- While editing: "Save or discard your edits first".
- No translation: "No translation of this chapter yet. Rewrites don't count."

**Compare** is unchanged. Change its tooltip to "Review and edit the original and this variant side by side".

### 07 · Components
New pieces, built on the existing components:

| Component | What it does |
|---|---|
| `BilingualToggle` | Pressed-state button + translation picker |
| `BilingualBar` | The second bar row |
| `SpeakSwitch` | SegmentedControl with a speaker glyph and disabled reasons |
| `PassagePairs` | Wide grid or stacked pairs; owns the follow band and scroll-away detection; Column and Text variants |
| `LinkedToken` | Word marks + click-to-inspect |
| `InspectPopover` | Popover, plus a sheet variant under 700px |
| `FollowPill` | "Back to the … voice" |
| `TimingBadge` | Existing granularity badge, extended |

**Accessibility**
- Screen-reader order: passage 1 original, passage 1 translation, passage 2, and so on. Each paragraph carries `lang` and `dir`.
- Column headings are `aria-hidden`; each passage is labelled by language.
- A live region announces voice switches and "Following paused". Word highlights are not announced.

**Bidi**
- Each text keeps its own direction. Hebrew is RTL only inside its paragraph.
- Bar, time (08:30), and headings stay LTR.

### 08 · Later (annotations only)
**Chapters**
- Scoped to the selected chapters + translation.
- "Pair sentences" action, plus an optional "Link words…" with an estimate shown before starting.
- Per-chapter status: Paired / Words linked / Pairing n% (Cancel) / "2 of 9 failed" (Retry).
- Completed work is preserved. Opening the view starts nothing.

**Outputs**
- Choose two texts, then their available narrations.
- Missing audio and missing translation are listed separately.
- No new output type or version label.

## State (reader)
- `bilingual: boolean`, persisted per book
- `translationKey`, persisted per book
- `view: 'column' | 'page' | 'text'` (existing)
- `voice: 'original' | translationKey`
- `playing`, `ms` (existing)
- `followPaused: boolean`
- `inspect: { side, tokenId, groupId | null, sentenceId } | null`
- `translationDisplay: 'shown' | 'onTap'` (narrow), plus the set of passages revealed on tap

**Data needed**
- per chapter + translation: passage pairs
- sentence pairs, which may be many-to-many or unpaired
- optional word-link groups, which may be discontinuous or repeated
- per-recording word timing quality (word / sentence / chunk)
- per-crop paragraph y-ranges (Column view)

## Design tokens (all in `packages/web/src/styles.css`)
**Existing**
- `--cue-linked` (orange a15)
- `--cue-active` (a35)
- `--cue-word` (a60)
- `--cue-ring` (orange-600)
- `--bg-reading`
- `--font-reading` (Source Serif 4)
- `--accent`, `--accent-text`, `--accent-subtle`
- `--bg-selected`, `--bg-subtle`, `--bg-card`
- `--border`, `--border-input`
- `--text-primary` … `--text-faint`
- `--success-*`, `--warning-*`

**Proposed addition:** `--insp-bg` (neutral inspection fill): `light-dark(rgb(58 44 30 / 11%), rgb(253 241 228 / 16%))`.

**Fonts**
- Hebrew needs a serif fallback in `--stack-reading`; the prototype uses Noto Serif Hebrew.
- Cyrillic is covered by Source Serif 4.

The `--page-paper` / `--page-ink` values in the prototype only simulate the PDF crop. Don't ship them.

## Open questions for backend
- Paragraph boundaries per column crop: which data source?
- The anchor format for `at=`: sentence id vs character offset.
- Whether sentence pairs can be many-to-many in the first contract. The design supports it.
- The word-link estimate unit (time vs cost) for "Link words…".

## Files
- `Bilingual Reader.dc.html`: the board (artboards 01–08; 02 is interactive).
- `support.js`: the runtime that the board needs to open.
- Source brief: `docs/two-languages-design-brief.md`.
