# Task: Chapter Transform (AI writes the chapter's text)

## Goal

One "Transform" action on a chapter: pick a preset or write your own prompt, watch the result
stream in beside the current text, and — if you like it — set it as the chapter's text. Reverting is
the existing `Reset`. `Cleanup (AI)` becomes the first preset rather than its own button.

The point of the feature is not tidier text. It is that the model can be given the chapter's *pages*,
not just its words, and write in the things extraction discards — charts, tables, plates — so they
end up in the audio instead of vanishing between two paragraphs.

## Why

`Cleanup (AI)` already *is* this feature, hardcoded to one prompt with no preview and no choice of
model:

- `workers/cleanup.ts` chunks `customText ?? cleanText ?? rawText` with `splitIntoChunks`,
  calls `lib/cleanup.ts#cleanupChunk` per chunk, and writes the joined result into `customText`.
- Progress and failure live in the `chapters.cleanup` jsonb; `Reset` undoes the result.

So the pipeline for "AI rewrites this chapter in place" exists and is proven — what is missing is the
prompt, the preview, and the model choice. Everything the user sees of it today is a button whose
label does not say what it does.

## What already exists to reuse

- **Prompt-driven transforms**: `chapterVariants` with `kind: "transform"`, `TRANSFORM_PRESETS`
  (ELI5 / Shortened / Summary / Enriched), custom prompts with an inferred label,
  `chunked` vs `whole` mode, `variants.createTransform` / `start` / `stop`.
- **Streaming preview**: `VariantModal` consumes `/translations/:id/stream` (snapshot / delta /
  thinking / status) and renders the original beside the output.
- **Prompt UI shape**: `ChapterAiModal` — presets as pills, editable prompt, `ModelPicker`,
  a token/context estimate, streamed answer.
- **Apply / revert**: `chapters.updateText` and `chapters.resetText`.

The new work is the *seam*: a transform that targets the chapter itself instead of a variant lane.

## Design decisions

### In place, not a lane

Variants answer "give me a second rendition of this book" (a Bulgarian lane, an ELI5 lane) and stay
as they are. Transform answers "fix *this* chapter's text" — one output, written to `customText`,
revertible with `Reset`. Keeping them separate avoids a lane per one-off cleanup.

### Reuse the worker, generalize the payload

Chapters run to 30+ chunks, so the run must survive closing the modal — a purely streamed,
tab-bound run is the wrong shape. Generalize the existing worker rather than adding a second one:

- `workers/cleanup.ts` → `workers/transform-chapter.ts`, payload gains `{ prompt, presetId, model, mode }`.
- `lib/cleanup.ts#cleanupChunk` becomes the `cleanup` entry in the preset table, prompt unchanged.
- Column `chapters.cleanup` keeps its physical name and gains `presetId` / `label`; the TS type is
  renamed. Same precedent as `chapter_translations` holding transforms.
- `chapters.queueCleanup` / `stopCleanup` → `chapters.startTransform` / `stopTransform`.

### Preview then apply — not apply on finish

The worker writes to a staging field, not straight over `customText`. The modal shows result beside
current text with `Apply` / `Discard`. Cleanup today overwrites silently, which is why its result is
only discoverable by noticing the `cleaned` badge.

Cheapest staging that needs no migration: keep the result inside the `chapters.cleanup` jsonb
(`result: string`) and have `Apply` call `chapters.updateText`. Revisit if chapters get big enough
that the jsonb row hurts.

### Presets

`cleanup` (artifact stripping, the existing prompt), plus the four `TRANSFORM_PRESETS` already
written, plus Custom. One table, shared by this and by the variant lanes, so a prompt is written
once.

### Page images: giving back what extraction threw away

This is the headline capability, not a nice-to-have. Extraction keeps only `Text`, `SectionHeader`,
`ListItem` and `Handwriting` blocks (`marker.ts#KEEP_BLOCK_TYPES`) — every `Figure`, `Picture`,
`Table` and `Caption` is dropped from `rawText`. A listener hears a chapter with its charts, plates
and diagrams silently missing, and no amount of text-only prompting can recover them.

With the page image in the prompt, a transform can narrate them: "describe each figure in one or two
spoken sentences, in place" turns a stripped chart into something you actually hear. That is the
version of Transform worth building — cleanup is the small case of it.

The locations are already in the database. Excluded blocks stay in `chapters.sourceBlocks` with
their `type`, `page` and `polygon` — so for each dropped figure we know which page it is on, where on
that page it sits, and exactly which paragraph it fell between. That gives the insertion point for
free; the `Blocks` view already lists them struck through.

Presets this unlocks, beyond cleanup: **Describe figures inline**, **Narrate tables**,
**Read captions**.

Obstacles, both real:

- `llmChat(system, user)` takes strings; image parts need the AI SDK message form and a
  vision-capable model. `availableModels` would have to carry that capability — LM Studio already
  reports `vlm`, cloud providers are known statically.
- Nothing rasterizes a PDF page server-side today: `PdfPreviewModal` is an iframe and the reader
  draws pages client-side with `PdfCanvas`. Either capture that canvas (`toDataURL`, cropped to the
  block polygon) in the browser and post it with the request, or add a `pdftoppm` call in the worker.
  The worker path is the right one for a background run — the browser path is the fastest way to
  prove the prompt works.
- Only marker-extracted books have `sourceBlocks`; pdftotext-first uploads have no block geometry,
  so those fall back to whole-page images for the chunk's pages (chunk previews already carry `page`).

Ship the text-only transform first, then this — but design the payload for it now
(`{ prompt, presetId, model, mode, images? }`).

One consequence to face: inserted figure narration is text that exists nowhere on the page, so the
page read-along cannot mark it. Today any `customText` already drops the chapter to reader mode
`text` (`reader-doc.ts`), which is the crude version of the right answer — the better one is marking
the words that do map and letting the inserted sentences pass unmarked.

## Related defect: text changes leave the audio stale

Found while researching. Cleanup and `Edit` both rewrite the spoken text without touching
`status`, `audioPath` or `synthesizedWith`, so a chapter keeps audio of the *old* text and still
reads `done`. Worse, writing `customText` drops the reader out of page mode (`reader-doc.ts`), so
read-along silently degrades to a transcript.

Fix alongside this task: record the text's hash in `synthesizedWith` at synthesis time (jsonb, no
migration) and show a "text changed since synthesis" mark plus a re-synthesize prompt when it no
longer matches. Applies to `Edit` and Transform alike.

## UI

`Ask AI` (read-only, answers questions) and `Transform` (writes the chapter) sit side by side in the
chapter modal toolbar — same modal shape, two verbs.

```
Transform · Chapter 3                                          [model ▾] [x]

 presets: [Cleanup artifacts] [ELI5] [Shorten] [Summary] [Enrich] [Custom]
 ┌ prompt ─────────────────┐  ┌ current text ──┬ result (streaming) ──┐
 │ Remove OCR artifacts... │  │                │                      │
 └─────────────────────────┘  └────────────────┴──────────────────────┘
 ≈ 4.2k tokens · 3% of DeepSeek's context      [Run]   [Discard] [Apply as chapter text]
```

Running state belongs here, not in the toolbar. Closing the modal leaves the run going; the chapter
row and the modal both show it is running, as cleanup does today.

## Retire

- `Cleanup (AI)` / `Stop cleanup` buttons, their progress span and error spans in `ChapterModal`.
- The `cleaned` badge becomes "transformed · {preset label}".

## Tests

- `workers/cleanup.test.ts` and `routes/chapters.test.ts` cover queueing, the run token takeover and
  the stop path — they move with the rename and keep asserting the same behaviour.
- New unit: apply writes `customText`, discard leaves it untouched.
- New e2e (`uc2-ask-ai.spec.ts` neighbourhood): open Transform, run a stubbed model, apply, assert
  the chapter shows the transformed text and `Reset` restores the original.
