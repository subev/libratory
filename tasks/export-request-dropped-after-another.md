# Queue a second export for a book instead of refusing it

`books.exportDocument` refuses with "Assembly already in progress" while the book's status is
`assembling`, and the assembly pool starts a queued export within milliseconds of the request, so
two requests for one book sent back to back — a read-along EPUB and then its bilingual edition —
always lose the second one. Scripts filling the public shelf on 2026-10-11 hit it three times; the
refusal is named, so a careful caller sees it, but the UI's single Export dialog cannot and an
agent scripting exports has to sleep between calls.

The refusal predates the per-format `jobKey` (`documentJobKey`, `jobKeyMode: "replace"`), which
already collapses repeat requests for the *same* output. With that in place a second export of a
different format or language can simply queue: the pool is serial per book anyway, and the worker
sets and clears `assembling` around each job. Keep the refusal for `books.assemble` (an M4B over
chapters that may be mid-export) only if something still depends on it.

Test: two `exportDocument` calls for one book, different formats, in one tick, expect two jobs and
two documents.
