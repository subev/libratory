# Preserve chapter work when changing boundaries — what is left

Done (2026-10-12, chapter crafting): changing boundaries never runs OCR or transcription; a
chapter cut from the same blocks as a saved one keeps its row, text override, variants and audio
(its index-named files move with it); an edited text override a cut breaks needs an explicit
keep/discard decision; only replaced chapters lose their audio. See `lib/structure-plan.ts`,
`lib/structure-apply.ts` and `components/ChapterCrafting.tsx`.

Still open:

- A restorable previous structure. Applying replaces the old chapters outright; undo exists only
  for the draft, not after apply. Keep a snapshot (boundaries, titles, edits, audio references)
  that a later apply can bring back.
- Crash recovery mid-apply. The rows change in one transaction and a failure it reports rolls the
  staged file moves back, but a process that dies between staging the files and committing the rows
  leaves `.moving-*` staging names or `.removed` files beside the chapters with nothing to put them back. A boot
  sweep that finishes or reverses a staged move would close that.
- Page artifacts in the portable extraction archive, independent of chapter output cleanup.
- Tests for a failed preparation/commit and for verse/footnote block mappings across a cut.
