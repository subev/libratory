# The main use cases — the happy paths the app promises

Distilled from **"The Libratory Playbook"** (the in-app book whose chapters narrate the five
YouTube guided tours; see `project` memory / the playbook book in the Demo profile). Those
videos are the app's public contract: whatever they show working is what must keep working.
This doc restates them as concrete, assertable user journeys so that agents writing e2e tests
(`tasks/e2e-infra.md`) test the promises, not implementation details.

Each journey lists the steps a user takes and the outcome the video shows. "Assert" lines are
suggestions for the strongest cheap assertion, not an exhaustive spec.

## UC1 — Core loop: PDF in, audiobook out (video 1)

1. Drop a PDF onto the home page → a book appears; raw text is extracted within seconds; the
   book is immediately readable and searchable.
2. Extract chapters → boundaries are detected; the book gets chapter rows.
3. Open the Structure view → every detected heading is listed; check/uncheck headings and
   Apply → chapters are re-cut accordingly (the "when it guesses wrong, fix it yourself" promise).
4. Select chapters, pick a voice, synthesize → each chapter becomes its own audio file;
   a single chapter can be re-synthesized alone.
5. Assemble → one file with chapter markers (M4B today); it is downloadable.

Assert: book row appears; `rawTextTotalWords > 0` quickly; chapter count > 1 after extract;
Structure modal lists headings and Apply changes chapter rows; chapter status reaches `done`
with an audio path; assembly produces a downloadable output. (E2e can stop at "chapter queued
for synthesis" if TTS is too slow for CI — see task doc non-goals.)

## UC2 — Ask AI on one book (video 2)

1. Open Ask AI from the book page (or chapters) → choose scope: whole book or selected chapters.
2. Pick a preset (Summarize / Explain simply / People & terms) or type a prompt; pick a model.
3. Answer streams in; it is **saved to the book's notes automatically**.
4. Any note can become a new chapter with one click ("a summary becomes part of the audiobook").

Assert: streamed text renders; a note row exists after the stream ends; note→chapter creates a
suspended chapter with the note's text; the context meter warns when scope exceeds the model's
context.

## UC3 — Chat with a book / citations (video 2)

1. Open chat scoped to a book, ask a question → the model searches (not full-text-stuffing),
   answers with `[c_N]` citations rendered as chips.
2. Click a citation → the PDF opens at that exact page.
3. Works on originals and translations alike.

Assert: an answer with ≥1 verified source chip; clicking the chip opens the PDF preview at the
cited page.

## UC4 — Translate & transform variants (video 2)

1. Select chapters → translate into a language, or rewrite (ELI5 / shortened / summary / custom
   prompt), choosing model + Reasoning toggle.
2. Each result is a **variant lane**: own text, own voice, own audio; the original untouched.
3. Generation streams token-by-token into the side-by-side view (thinking visible when on).
4. AI cleanup strips OCR artifacts without touching prose (writes `customText`).

Assert: variant row reaches `done` with non-empty text and a translated title; original chapter
text unchanged; a stopped/interrupted variant can be resumed without losing finished chunks.

## UC5 — Library at scale (video 3)

1. Drop a whole folder → each PDF becomes a book; every book is **indexed automatically** on
   text arrival (no chapter extraction needed first).
2. Library chat across everything (or scoped to a folder) → cited answers; keep answers as notes.
3. Folders organize; drag books in; folder activity at a glance.
4. Digests: select several books, describe the style → one AI summary chapter per book lands in
   a new book, **suspended for review** before synthesis.

Assert: N books from one drop; search index status reaches done per book; scoped chat only cites
in-scope books; digest book contains one suspended chapter per source with a saved note each.

## UC6 — Documents out & read-along (video 4)

1. Export selected chapters as PDF or EPUB — for the original or any variant lane.
2. Synced EPUB: text + narration + timing map; in a media-overlay reader each
   sentence highlights as it is spoken.

Assert: export job produces a document file; synced EPUB contains audio + a media-overlay
timing map referencing the chapter audio.

## UC7 — Extensions: text in, audiobook out (video 5)

1. `POST /api/books` with a title and chapters → a book appears, ready to review/synthesize
   (or auto-synthesizing if requested).
2. HN digest: pick a date range, preview stories → the day's top stories become a
   radio-segment book.

Assert: API-created book shows the `api` badge with its chapters intact; HN digest creates a
book with one chapter per story.

## UC8 — Read along on the page

1. Click **Open reader** on a book that has chapter audio.
2. The narration plays and the sentence being spoken is highlighted on the book's own PDF page;
   the page follows along, standing back when you scroll by hand.
3. Tap a sentence on the page and the audio jumps to it.
4. Column, Page and Text views share one timeline; the phone width presets say whether this
   book's type is actually readable on a phone screen.
5. Hovering a sentence on the page rings it and lights the chunk it belongs to; hovering a chunk
   tints the print it became. The transcript binds the same way.
6. When a chapter's audio ends the reader rolls on to the next narrated one, and **← Back**
   returns to the chapter you were reading. **Space** plays and pauses, in the reader and in the
   chapter modal alike.
7. Opening a chapter reads along on the same pages inside its modal. A chapter whose text has
   moved on from the print — edited, cleaned, translated — still opens its pages, unmarked and
   with a line saying why.

Assert: the reader lists cue rectangles for a chapter with audio; clicking one moves the audio
position; the read-along entry is disabled for a book whose chapters have no audio.

## Supporting promises (all videos)

- **Profiles**: separate workspaces, one click away; list views are scoped per profile.
- **Free path always works**: with zero cloud keys, the free/local voices and local models keep
  every flow above functional (the settings gear shows what's available).
- **Disk usage view** shows a book's weight and frees heavy parts; **log dock** records every
  action taken on a book.
- Model choice: every AI flow above accepts a model from the picker (cloud or auto-discovered
  local); the picker is grouped by source and shows context sizes.
