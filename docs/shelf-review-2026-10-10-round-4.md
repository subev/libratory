# Shelf review, round 4 (2026-10-10)

Scope: uncommitted description + attach-edition + PhonePage notice hunks on top of 427541d.
`npx vitest run src/lib/synced-epub-books.test.ts`: 7 passed.

## Verdict
Fix finding 1 (overwrites a sibling edition's file) and 2 (unvalidated manifest description) before commit; the rest are small.

## Findings

### 1. High: attaching a file with an existing edition's filename overwrites that edition's file
`lib/synced-epub-books.ts:240-241`: `documentPath = outDir/safeName(filename)`, then `move` -> `rename`, which silently replaces. The common case (re-syncing the same book, same export filename, onto a book created by `createSyncedEpubBook`, same `outDir`/`safeName` at :173) leaves two `documents` rows with one `outputPath`. Deleting either document removes the other's bytes; the older edition silently changes content. The test uses different names (`first.epub`/`second.epub`), so it does not see this. Fix: pick a unique name (suffix with the new document id or a timestamp) or refuse if `stat` finds one.

### 2. Medium: `manifest.book.description` is unvalidated from an untrusted file
`lib/synced-epub-books.ts:185` inserts `manifest.book.description ?? null`. `isReaderManifest` (`lib/synced-epub.ts:77-81`) checks only that `book` is an object, so a non-string (number/object) makes the insert fail with a 500 rather than a 400, and a string has no cap (the plain-EPUB path caps at 2000, `epub-import.ts:122`, and the tRPC route at 2000, `routes/books.ts:482`). Fix: `typeof d === "string" ? d.trim().slice(0, 2000) || null : null`. `author` has the same pre-existing gap; not part of this diff.

### 3. Medium: recorded narration `level: "sentence"` is a guess
`lib/synced-epub-books.ts:255` hard-codes `sentence`. The shelf surfaces this (`narrationSummary`, `document-narration.ts:126-134`), and the cue documents inside the EPUB carry the truth (`ReaderCues.granularity`, `reader-format.ts:67`). A chunk-level or word-level export is mislabelled; the create path reads real sync maps (`laneFromRecordings`, `document-narration.ts:63-75`). Also, an `epub-bilingual` attach records `translation: null` even though the file has two lanes (the create path does the same, so pre-existing, but attach makes the shelf row inaccurate for the exact "bilingual copy beside the read-along" case the comment names). Better: read `granularity` from the cue entry (or `combineLevels` over them) and, for bilingual, fill the second lane. If that is too much, `level` is typed non-null so "unknown" is not expressible; at least say so in the comment. `voice: null` is honest.

### 4. Low: uploaded temp dir leaks on the invalid-uuid early return
`upload-routes.ts:138`: `return reply.code(400)` happens after the file was written to `bookDir/source.epub` and before any `rm`/`deleteBook` (the catch is not reached). A multi-GB file stays in `uploads/<newId>`. Validate `fields.bookId` before streaming is impossible (fields can follow the file), but `rm(bookDir)` before that return fixes it.

### 5. Low: orphan file when the attach insert fails after the move
`synced-epub-books.ts:241` moves the file into the existing book's `outDir` before the insert (:244-258). If the insert throws, the route's catch runs `deleteBook(bookId)` on the fresh id (safe, see non-issues), so the moved file stays in the real book's output dir with no row. Move after the insert, or `rm` on failure.

### 6. Low: description stripping
`epub-import.ts:122`: `firstText` collapses all whitespace first (`:219`), so paragraph breaks are lost; the tag regex also eats `a < b ... c > d` text, and HTML entities double-encoded in the OPF (`&amp;nbsp;`) remain. `.slice(0, 2000)` can cut a surrogate pair. Acceptable for a catalogue line; note only.

### 7. Nit: comment narrates
`PhonePage.tsx:75` ("The same query the phones card runs; ...") explains what, not why. It is also a second subscription with its own 5 s `refetchInterval`; harmless, same query key dedupes in practice if the options match.

## Non-issues (verified)
- Wrong-book deletion: the route's catch calls `deleteBook(bookId)` with the freshly generated id from `newPdfBookId()` (`upload-routes.ts:107,153`), never `fields.bookId`; `deleteBook` (`delete-book.ts:8-18`) no-ops the row delete for a missing id and removes only `uploads/<fresh>`, so a throwing attach cannot delete the target book.
- `epubPath` is already moved out before `rm(bookDir)` on success (`move` at :241 precedes route's `rm` at :140); on the EXDEV path the source is removed too.
- Profile check: `book.profileId !== profileId` with the same message as "not found" (`:235`), so no existence oracle; tested.
- `chapterIds: "[]"`: only consumers are `parseChapterIds` in `backfillDocumentNarration` (`document-narration.ts:149-175`), which selects `narration IS NULL` rows; attach always writes a non-null narration object, so it is never backfilled into an empty lane. `parseChapterIds("[]")` is safe anyway. No Phone-page code reads `chapterIds`.
- Manifest `description?` is optional in the type (`reader-format.ts:43`) and the import uses `?? null`, so older readers/exports work; `reader-doc.ts:96` always emits it (null when empty), which older readers ignore.
- Unions/`!`/`any`: none added. (`(part as any).value` in the route is pre-existing.) Textarea reuses the `field` class and `px-2 py-1.5`, tokens only; `max-w`-style rules not applicable. Route `.max(2000)` matches the import cap.

## Test gaps
- No test for same-filename attach (finding 1), a non-string/oversized manifest description (2), a bilingual attach's narration/lane (3), or the route (`bookId` field, invalid uuid, other profile's book -> 400, temp dir removed).
- `shelf.test.ts` only adds `description: null`; no case with a non-null description flowing to the listing.
- No test that `dc:description` markup is stripped/capped (`epub-import`) or that `updateSettings` clears with an empty string.
