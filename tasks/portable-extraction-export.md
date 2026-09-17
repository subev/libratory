# Export and restore completed extraction

Completed OCR and paid AI extraction must be portable. Re-importing a processed
book should not require repeating recognition, ordering, or transcription.

The Strandzha run exposed the gap: the searchable PDF stores page images and
positioned text, but semantic verse/prose groups, chapter boundaries, extraction
settings, paid responses, and read-along geometry live outside it. Ordinary PDF
upload skips text-layer OCR when text exists, then runs Marker structure extraction;
it does not restore the saved AI layout or existing chapters.

The source-file row now offers Download searchable PDF with the original filename
and an OCR suffix. It is disabled until a searchable copy exists. This exports
the PDF only; the rest of this task concerns full restoration.

Complete the portable workflow:

- Export book from the book menu: a versioned portable archive of source PDFs,
  searchable copies, semantic extraction, word geometry, settings, chapter text
  and source blocks. Include existing audio/variants or state their exclusion.
  Importing this archive should restore a new book with processing suspended and
  require zero model calls. No credentials, queued jobs, or transient statuses.

Validate paths, sizes, hashes, schema versions, and references before committing
an import. Remap IDs for imports alongside the original. Preserve inserted
chapters and user text edits. Do not treat arbitrary PDF attachments as trusted
extraction data if a self-contained PDF format is explored later.

Acceptance: export a completed mixed prose/verse book, import into a fresh book,
and compare chapter text, block kinds, line/stanza boundaries, source mappings,
and read-along positions with no OCR or AI calls. Existing ordinary PDF imports
must retain their current behavior.

A manual recovery archive for the current book exists under
`packages/server/data/exports/strandzha-extraction-2026-09-17.zip`. It is not yet
an application import format; its manifest documents the mappings and limits.
