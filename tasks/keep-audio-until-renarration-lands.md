# Keep a chapter's audio until its re-narration lands

`chapters.queue` (`routes/chapters.ts`) clears `audioPath`, `durationMs` and `synthesizedWith` the
moment a chapter is queued again. The file itself stays on disk until the new run overwrites it, but
the row no longer points at it. If the new run fails — a cloud voice out of credits, a crash — a
chapter that had audio now has none, and the book's M4B, exports and read-along lose it until the
chapter is narrated again.

Seen in the MCP dogfood of 2026-09-30 (`docs/mcp-dogfood-bilingual-2026-09-30.md`, finding 25):
re-narrating Letter 1 took `withAudio` from 14 to 13 before the run started. It succeeded, so nothing
was lost that time.

Shape of a fix: leave the audio columns alone at queue time and let the synthesize worker replace
them when the new file is written, as the variant lane could too. Everything that reads
`audioPath !== null` as "has audio" would then keep playing the old recording during the run, which
is arguably right. Exports already gate on `status === "done"`, so a chapter mid-run is still left
out of one. Check the chunk-cache resume path and the sync map (written beside the audio) before
changing it: a half-written new sync map next to the old audio would mis-time the read-along.
