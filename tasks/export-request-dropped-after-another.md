# A second export request for the same book answers success and queues nothing

Seen three times on 2026-10-11 while filling the public shelf by script: `books.exportDocument`
called for a book's `epub-bilingual` right after an `epub-sync` request for the same book (within
a second) returned `{ success: true }` and produced no job, no log line and no document. The same
request sent on its own a minute later ran at once. Reproduced for the Carol (Spanish) twice and
Frankenstein (Bulgarian) once; the four `epub-sync` requests sent in the same burst all ran.

Suspects, unverified: the `documentJobKey` with `jobKeyMode: "replace"` on a key that does not
include the format, so the bilingual request replaces the sync one or vice versa; or the
`books.status === "assembling"` check racing the first job's status write and an error path that
still answers success. Start at `routes/books.ts` `exportDocument` and `lib/output-readiness.ts`.

Fix should make the second request either queue beside the first or refuse by name; a success
that does nothing is the worst of the three. A test: two requests for one book, different formats,
in one tick, expect two jobs.
