# Task: Chapter Modal Declutter

## Goal

Cut the chapter modal down to the controls that earn their place, and rename the ones that stay
so each says what it opens. No new capability — everything here is removal, renaming, or moving a
control behind the action it belongs to.

## Why

The modal has grown two full toolbars plus a preview panel: 4 action buttons, a voice chip, a
cleanup pair, 7 view tabs, a 30-button chunk grid, a native audio element, and two link-styled
buttons that duplicate each other. Most of it is state the reader cannot act on. Three of the
controls open the same PDF, two of them play the same audio, and one ("Open latest file") opens a
raw chunk file in a browser tab.

## What the current controls actually are

Researched before proposing removals, because several are not what their labels suggest.

| Control | What it really does |
| --- | --- |
| `Voice Heart (F)` chip | Book-level (or variant-lane) voice for the *next* synthesis. Not a property of this chapter. |
| `Re-synthesize` | Queues synthesis with that voice. `Start over` when the chapter is suspended/failed. |
| `Cleanup (AI)` / `Stop cleanup` | A graphile worker that chunks the current text, sends each chunk to the LLM with a hardcoded OCR-artifact prompt, and writes the joined result into `customText`. It is one hardcoded instance of the missing transform feature — see `tasks/chapter-transform.md`. |
| `PDF p.2` (chunk row) | Opens `PdfPreviewModal` at the active chunk's page. |
| `p.2–3` (header) | Opens the same `PdfPreviewModal` at the chapter's first page. |
| `Open latest file` | `<a target=_blank>` to the last chunk preview URL — a bare WAV/M4A in a browser tab. |
| `Read along on the page` | Link to `/books/:id/read?chapter=N` — the full reader. |
| Chunk grid | Chunk selection, and the only place "which chunk is playing" is shown. Earns its line. |
| `Chunk 5` label + `<audio controls>` | A third playback line that repeats the highlighted chunk button and adds a scrubber for a 10-second clip. |
| `Pages` / `Text` | Two renderings of the same read-along: page images when the chapter can be marked on the page, cue transcript when it cannot. Already a fallback ladder in `viewMode`. |
| `Clean` | `cleanText` — deterministic TTS normalization of `rawText` (`normalize.ts`), *not* AI. This is what the voice speaks unless `customText` exists. |
| `Raw` | `rawText` as the extractor produced it. |
| `Split` | Raw beside Clean — a diff between two texts nobody edits. |
| `Blocks` | Source blocks with page numbers and included/excluded flags. Extraction diagnostics. |

## Target shape

```
#3  What each one is for        [done] [cleaned]
202 words · 1:38 · Heart (F) 1x        [View PDF p.2–3] [Open reader]

[Download] | [Re-synthesize] | [Ask AI] [Transform]        [Original|BG] [Edit] [Read|Source|Compare|Blocks]

[▷] [1.75x]  Chunk previews (20)
[Chunk 1][Chunk 2][Chunk 3] ... [Chunk 20]
```

## Chunk 1 — Synthesis: the voice moves inside the button — DONE

- Drop the always-on `VoicePickerChip` from the toolbar.
- `Re-synthesize` (and `Start over`) opens `SynthesizeModal` with `count={1}`, the current voice and
  speed, and starts on confirm. That component already hosts the voice library and states that voice
  and speed are saved on the book / variant lane, which is the honest scope today
  (per-chapter voice is parked in `tasks/per-chapter-voice-speed.md`).
- `Continue (12/30)` keeps queueing directly — resuming must not offer a voice it will not use.
- The voice stays visible read-only in the header meta line, where `Heart (F) 1x` already is.

## Chunk 2 — Source and reader: two buttons, said plainly — DONE

- `p.2–3` becomes a labelled button: `View PDF · p.2–3`, opening `PdfPreviewModal` as it does now.
- `Read along on the page` becomes `Open reader`, keeping the disabled + tooltip treatment
  (`markReason`) when the chapter cannot be marked.
- Delete `PDF p.N` from the chunk row (duplicate) and `Open latest file` entirely.
- Both buttons move to the header meta line, so the toolbar holds actions and the header holds
  where-this-came-from.

## Chunk 3 — The player line goes, the player stays — DONE

The panel spends three lines on playback. The bottom one carries nothing the two above it don't
already say: the `Chunk 1` label repeats the highlighted button in the grid, and nobody needs a
scrubber for a 10-second chunk.

- Delete the bottom row entirely — the `Chunk N` label and the `<audio controls>` element's chrome.
- Keep the `<audio>` element itself, hidden. It is what plays, what drives `onTime`, and therefore
  what marks the words on the page — removing it would kill read-along inside the modal.
- The `▷` icon button and the speed select at the top left stay as the only transport, which is what
  they already are.
- The chunk grid stays: the highlighted button is where "which chunk is playing" is read, and
  clicking one still selects and plays it.
- Seeking survives where it is better than a scrubber — clicking a highlighted span in the text pane,
  or a marked line in the page view, seeks to it (`chunkRanges` / `ChunkedText` / `CuePages`).

## Chunk 4 — View tabs: Read / Source / Compare / Blocks — DONE

Collapse seven tabs to four, keeping every rendering that exists today:

- **Read** — page images whenever they still hold the chapter's text (reader mode `page`), else the
  spoken text (`customText ?? cleanText ?? rawText`) with its paragraphs and chunk spans.
  Absorbs `pages`, `text`, `custom`, `clean`.

  Shipped without the cue transcript: it was the "wall of text" — cues rendered as one inline run,
  losing every paragraph break. Its one advantage, word-level marking, only applies where the pages
  cannot mark, and there the paragraphed spoken text with chunk-level seeking reads better. The full
  reader keeps the transcript.
- **Source** — `rawText`, as extracted. Renamed from `Raw`; it is a diagnostic, not a reading view.
- **Compare** — replaces `Split`. Right pane (`Spoken`) is always the spoken text; left is the layer
  it came from — `Previous` (`cleanText`) when a custom text exists, otherwise `Extracted`
  (`rawText`). So it answers "what did the edit / the AI actually change".
- **Blocks** — unchanged, still gated on `hasSourceBlocks`.

`Source` and `Compare` appear only when a normalized or edited text exists — without one the
extracted text *is* the spoken text, and Read already shows it.

`e2e/tests/uc8-read-along.spec.ts` used `view-tab-pages` in four places: three became implicit (Read
is the default) and one became `view-tab-read`. Its edit-unbinds-the-print assertion now checks that
Read falls back to the edited text instead of showing pages with a notice.

## Chunk 5 — Cleanup leaves the toolbar

Blocked on `tasks/chapter-transform.md`. Once Transform exists, `Cleanup (AI)`, `Stop cleanup`, the
inline progress span and the two mutation error spans all leave the toolbar; cleanup becomes the
first preset inside the Transform modal, and its running state is reported there.

Until then, the minimum fix: `Stop cleanup` renders only while cleanup is running, instead of sitting
there permanently disabled.

## Also done alongside

The chapters table's per-row re-synthesize icon opens the same picker as the modal's button, so the
two paths to one action ask the same question.

## Not doing

- `Download` stays — it is the only way to get the chapter's audio file out.
- The variant pills (`Original | Bulgarian`) stay — they switch what the whole modal is about.
- `Edit` / `Reset` stay as they are; Transform will write through the same `customText` they use.

## Parked follow-ups (surfaced by the review passes)

- **Share the cue/chunk locator across the package boundary.** `packages/web/src/lib/text-cues.ts`'s
  `locateSpans` is a verbatim copy of the server's `locateChunks`
  (`packages/server/src/lib/chunk-previews.ts`), tests included. The repo already takes
  `reader-format.ts` across that boundary, but only as types — sharing this would be the first
  *runtime* cross-package import, plus a `tsconfig` include change. Not worth doing on the way to a
  release; the web copy names its twin in a comment so the coupling is findable.
- **The reader's transcript still has the wall-of-text problem the modal just fixed.**
  `CueTranscript` joins `cue.s` with spaces — no paragraphs, ever. The honest fix is to give the
  reader document the spoken text plus per-cue ranges and render it with the modal's marked-prose
  renderer, which would delete `CueTranscript` and the duplicated word walk with it.
- **`fetchManifest` re-downloads `book.json` on every chapter navigation** (its effect keys on the
  chapter's audio path, but the document is the book's). Now on the hot path since Read is the
  default view. Needs a cache with staleness rules around synthesis and edits.
- **The text pane re-tiles all 47 chunk spans on every playhead tick.** `ChunkPreviewPanel` is
  memoised now; the per-chunk span could be too, and the playhead could publish only when the cue
  or word index actually changes (~6×/s instead of 10×/s).
- **A word split across a chunk boundary lights on one side only** — the lamp measures the first
  `reader-word`. The sentence already lights on both; the lamp would need to union the boxes.
- **`voicePickerOpen` may be redundant** — `VoiceLibraryModal` suppresses Escape (capture phase) and
  arrows/Space (panel handler) itself. Wants a manual focus check before removing the prop.
- **Voice/speed are persisted fire-and-forget before the queue call**, so nudging the speed slider
  and clicking Start in the same instant can queue with the previous speed. Pre-existing in the bulk
  flow; the honest fix carries voice/speed on the queue call.

## Tests

- `uc8-read-along.spec.ts`: rename the three `view-tab-pages` uses.
- No e2e covers cleanup, the player line, or `Open latest file` — removals are safe.
- New: opening `Re-synthesize` shows the voice library and starts one chapter (extend `uc1-core-loop`).
