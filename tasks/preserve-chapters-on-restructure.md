# Preserve chapter work when changing boundaries

Page OCR, AI transcriptions, semantic layouts and word geometry are source-file
artifacts. Chapter structure is a grouping of those artifacts; changing it must
never trigger page recognition or transcription.

Current behavior already reuses page extraction for structure apply and chapter
re-detection. Re-detection now checks every source before replacing any chapters,
and keeps the existing rows and outputs when text, titles and source mappings are
identical. A changed structure still replaces all extraction-derived chapters,
their edits, variants and audio. Inserted chapters survive but their audio resets.

Next improvement: match unchanged chapters by source file and exact block ranges,
preserving their IDs, text overrides, variants, audio and reading metadata. Only
affected chapters should require re-synthesis. Split/merge must surface edited
text that cannot be mapped safely; never silently discard it.

Build and validate the complete replacement before a transactional database swap.
Delete obsolete artifacts only after commit. Keep a restorable previous structure
including edits and audio references. Guard against concurrent synthesis and
assembly. Keep page artifacts independent of chapter output cleanup and include
them in the portable extraction archive.

Tests should cover one boundary change leaving unrelated chapters intact, edited
text across a split, inserted chapters, failed preparation/commit, repeated apply,
and verse/prose/footnote mappings with no OCR or transcription calls.
