# Design brief: bilingual reading

Ready for a first design pass, 2026-09-28. Reader first; embedded chapter preview optional.
This brief describes requested behavior, not an implemented feature.

## Purpose and scope

Let someone read a chapter and its translation together, listen to either available narration,
and inspect corresponding words or expressions. It must remain useful with one narration, coarse
timing, missing word links, or a passage that has no reliable counterpart.

The standalone reader is the main experience. The chapter modal needs a clear way to open it;
an embedded preview is welcome only if it stays simple. Design the reading experience first.
Preparation and export need small supporting designs once their data contract is settled.

## Existing places to design

| Place | Present behavior | Requested change |
| --- | --- | --- |
| Standalone reader | Chapter picker, playback, speed, elapsed time; Column / Page / Text views | Bilingual entry, language choices, paired texts, linked highlights and inspection |
| Reader at narrow widths | Phone-width and landscape previews | Comfortable portrait and wider layouts with equivalent functionality |
| Chapter modal | Variant pills, text/page views, playback, editing and synthesis | Minimal contextual entry into the reader; optionally an embedded preview |
| Compare action | Opens Translate / Transform with original and variant text | Preserve its editing/review purpose; distinguish it from bilingual playback |
| Chapters stage, later | Text/variant preparation and selected-chapter actions | Pairing and optional word-link preparation, readiness and failure states |
| Outputs stage, later | Produced files and exports | Choosing the languages and available narrations to include |

Use language names, not flags. The selected translation and the spoken language are separate
choices. A translation can be readable without audio. Rewritten variants are not automatically
translations; the first experience targets an original and a translation.

## Proposed implementation boundaries

- Two displayed languages first. Multiple available translations need a picker, not more columns.
- Start with bilingual reflowed text. Keep a clear return to Page / Column at the same passage.
  PDF-plus-translation is a possible later extension, not a prerequisite. Translated text does
  not have translated PDF geometry.
- One narration plays at a time, with a visible indication of its language.
- Opening a reader does not start paid processing. Prepared exports work offline.
- Manual word inspection can work without word-level audio timing. Sentence following can work
  before word links are ready.

If a design needs to change a boundary, call out the reason and additional behavior required.

## First-pass artboards

### 1. Enter bilingual reading

Show a discoverable entry from the existing reader, translation selection and spoken-language
selection. Keep them distinct from chapter selection and reading view. Show availability when
the second text is missing or pairing is not ready. An offline book can explain missing data
but cannot offer server-side preparation; the connected experience can link to Chapters.

### 2. Wide reading and playback

Show two comfortable text columns, language headings, an active sentence pair and corresponding
word highlights where timing permits. Preserve paragraphs and punctuation. Sentence counts,
lengths and word order can differ; there is no guaranteed one-to-one sentence relationship.

Specify scrolling, keeping counterparts visible, browsing away from playback and returning to
the voice. Do not synchronize by scroll percentage: equivalent passages occupy different heights.

### 3. Narrow reading

Recommend a portrait arrangement, such as paired passages stacked in reading order, rather than
shrinking two columns. Show approximately 393px width, landscape and larger text. Resolve whether
the secondary text is continuously visible or revealed on demand. Transport and language controls
must stay reachable without covering the passage.

### 4. Word and expression inspection

Show a single counterpart, several counterparts, a discontinuous expression and an unlinked word.
“Turned … off” may correspond to one word; one compound may correspond to several words. Repeated
words highlight only their linked occurrences.

Specify distinct interactions for inspecting without moving playback, listening from a passage
or timed word, and ordinary text selection/copying. Cover mouse, keyboard and touch; hover alone
is insufficient. The existing reader uses tapping a passage to seek, so the bilingual gesture
choice must be deliberate. Show focus, dismissal and any explicit listen action.

Use “No linked counterpart” rather than “Untranslated”: absence of a link does not prove omission.
Dictionary definitions and generated explanations are outside this feature.

### 5. Change narration and handle incomplete data

Switching spoken language should stay at the corresponding passage. Specify whether playback
continues or remains paused. The destination is not the same timestamp or percentage of the
other recording. A practical initial fallback is the corresponding sentence start when a
trustworthy word anchor is unavailable. Show what happens when the sentence counterpart is missing.

| Condition | Behavior to show |
| --- | --- |
| Both texts and narrations ready | Either language can speak; only one plays |
| One or both narrations missing | Both texts remain readable; unavailable playback has an explanation |
| Sentence pairs ready, word links absent | Sentence following remains useful; no invented word counterparts |
| Word links ready, timing coarse | Manual inspection works; playback uses the supported highlight level |
| Uncertain or unmatched passage | Keep text visible without asserting a reliable correspondence |
| Partial preparation or failed link batch | Keep usable results; explain the affected area without blocking the book |
| Text edited after preparation | Old mappings are unavailable; current text remains readable |
| Narration replaced | Text links remain usable; timing must belong to the current recording |

Provider timestamps are not automatically accurate: tested recordings included uniformly spaced
and zero-duration word intervals. Show a quiet approximate/sentence-level state instead of claiming
exact word synchronization. Raw scores, provider diagnostics and token counts do not belong in
the normal reading flow. A missing word link and missing word timing are different conditions.

### 6. Chapter-modal access

**Required minimum:** a contextual “Open bilingual reader” action carrying the current chapter,
selected translation and passage when a valid anchor exists. Place it with reading/variant
controls, not among generation commands. Show availability while editing and when the translation
is missing. Opening the reader must not leave the modal's narration playing behind another player.

**Optional alternative:** reuse the bilingual reading surface in the modal's content area, with
one transport and an obvious route to the full reader. No nested modal or duplicate language and
playback toolbar. If it becomes crowded, recommend the minimal entry point and stop. A second
full reader implementation inside the modal is not requested.

## Supporting designs after the reader pass

First-pass annotations are enough here; a complete processing dashboard is not needed yet.

- **Chapters:** scope to selected chapters and translation; sentence readiness; optional word-link
  preparation with an estimate before starting; progress, cancellation and explicit retry after
  failure. Completed work is preserved. Merely opening a view does not start jobs.
- **Outputs:** choose the two texts and available narrations; identify incomplete chapters. Missing
  audio is different from missing translation. Do not invent a new output type or mandatory
  format-version label for the UI.

## Visual and accessibility constraints

Reuse existing controls, typography and semantic colors. Reading text uses the reading serif,
warm reading surface and a comfortable measure of about 65 characters per line. Do not widen
prose simply to fill a desktop window or render it as a dense data table.

Read-along uses the accent color. Distinguish spoken words, counterparts and manual inspection
without relying only on color. Keep playback distinct from annotations. Show keyboard focus and
check light/dark appearances, larger text and screen-reader order.

Each language follows its own writing direction. Include English–Hebrew with RTL Hebrew, LTR
English, punctuation and 08:30; do not reverse the whole interface because one text is RTL.
Include Bulgarian–German with unequal phrase lengths as a second sample.

## Handoff requested

Provide numbered artboards for the six areas, reusable components and short annotations covering
triggers, results, dismissal, focus, scroll/follow behavior and playback effects. Include missing,
loading and failure states wherever they change an action. Recommend one primary layout and the
minimal modal entry; label optional/later work rather than leaving unranked alternatives.

The handoff is ready when someone can open a chapter, enable bilingual reading, inspect a word,
switch narration, encounter a missing counterpart, change chapter and return to ordinary reading
without the implementer having to invent a behavior.

The first target is the web reader. Narrow-screen interactions should transfer to a later native
reader; a full native navigation redesign is outside this brief.

## Implementation references

- `packages/web/src/pages/Reader.tsx`: existing reader controls and reading surfaces.
- `packages/web/src/components/ChapterModal.tsx`: variants, playback and Compare entry.
- `packages/web/src/components/VariantModal.tsx`: existing Translate / Transform workflow.
- `tasks/two-languages.md`: proposed data and processing boundaries.
- `docs/two-languages-multilingual-review.md` and `docs/two-languages-reasoning-review.md`: measured
  limitations. The experimental viewer demonstrates behavior; its styling is not a specification.
