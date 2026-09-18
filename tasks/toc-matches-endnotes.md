# Chapter detection selects endnotes instead of body chapters

**Fixed 2026-09-17** in `toc-anchor.ts`: every strong title match is now an
anchor candidate and the page-offset chain keeps one per entry, so the body
offset (+13 here) wins over the notes; a leading chapter number and OCR word
splits no longer lower similarity; entries without a printed page are bounded by
the next entry that has one. Regression fixture:
`packages/server/test/fixtures/toc-duplicate-notes-headings.json`. The missing
page numbers on the second contents page are absent from the scan's own text
layer as well, so that part is a source problem.

Book: `839d00f9-4525-458c-8226-a78b018840a5`, Charles Taylor,
*Sources of the Self*. User requested diagnosis and intends to hand this to
another agent. Do not apply the current proposal: it groups most of the body
into one enormous chapter.

## Evidence

The 2026-09-17 16:43 UTC proposal finds the contents on PDF pages 8–9,
selects 26 entries, then logs that it cannot map printed pages to PDF pages.
It falls back to title-only matching. Most matches are headings in the Notes
section (which starts at PDF page 538), not actual body chapter starts.

Example: TOC chapter 3, printed page 53, belongs at PDF page 66. The body
heading is OCR'd as `ETHI CS OF INARTICULACY` (block 322, H1). The cleaner
notes heading `3. ETHICS OF INARTICULACY` at PDF page 543 (block 2929, H4)
wins. The proposal consequently stretches chapter 2 from PDF page 38 to 543.

`toc-anchor.ts` `findAnchors` chooses title matches globally. Notes headings
produce inconsistent offsets, so `buildPageMap` returns null. `locateEntries`
then searches the full catalog, and its forward-only `lastBlock` makes a wrong
match in the notes constrain subsequent choices to the notes too.

The log saying headings were placed on their expected pages is misleading when
there is no page map: these were title-only matches.

## Regression investigation

This book has no OCR engine selected and uses ordinary Marker output, not the
new ordered OCR pipeline. No chapter-matching algorithm was changed by that
work. Replaying the saved Marker output through `marker.ts` from `047f497^`
(before ordered OCR) and the current reader yields the same 3,957 blocks,
the same bad anchors, no page map, and the same 24 deterministic matches with
the first two numbered chapters unresolved. No new AI calls were made; the
comparison uses the saved proposal's TOC and selected titles.

Local reproduction and detailed results:

- `/tmp/libratory-extraction-diagnosis/compare-taylor.mjs`
- `/tmp/libratory-extraction-diagnosis/taylor-heading-comparison.json`
- Saved Marker source: `packages/server/data/tmp/839d00f9-4525-458c-8226-a78b018840a5/file_0/`

## Fix direction

Distinguish body headings from repeated notes headings, consider multiple title
candidates when establishing a consistent page offset, and avoid irrevocably
accepting a late match when printed-page evidence conflicts. Missing page numbers
in the latter half of the extracted TOC also need investigation. Add this book's
body/notes duplicate-heading case as a deterministic regression fixture.

Preserve existing page extraction and user chapter state while diagnosing.
