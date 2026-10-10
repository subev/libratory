# Shelf review, round 2 (2026-10-10)

Verdict: no blockers and no write-outside-the-book path found. Four medium findings, all in the import, and a handful of lows. Nothing was run; findings are from reading the code. No tests were executed.

## Medium

1. **Basename collision under `unzip -j`** — `lib/synced-epub-books.ts:113-115`. All audio entries are extracted flat into one stage dir and then picked up by `path.posix.basename(ch.audioEntry)`. Two chapters whose audio entries share a basename in different directories (`a/x.m4a`, `b/x.m4a`) extract to the same file. With `-o` the second silently overwrites the first, so two chapters get the same audio (with the first one's sync map wrong). If two chapters name the same entry, the second `rename` throws ENOENT, which the route turns into a 500. Not an escape (`-j` strips directories and the target is always `ch%03d`), but a crafted or odd file imports wrong audio without error. Fix: extract one entry at a time with `unzip -p entry > outPath` (streaming via spawn and `pipeline` to a file), which also removes the stage dir and the collision. Or reject duplicate basenames or duplicate audio entries up front.

2. **Entry names are passed to `unzip` as patterns, and as one argv** — `synced-epub-books.ts:113`. `unzip` treats member arguments as wildcards (`*`, `?`, `[...]`), so an entry such as `audio/ch[1].m4a` matches nothing, or matches more than it names. A name that matches nothing makes unzip exit with a non-zero "filename not matched" status, so the import fails with a 500 after the cues were read. Separately, one argv carries every audio entry. A book with a few thousand narrated chapters (about 60 bytes per entry) can reach the OS argument limit, and `execFile` then fails with E2BIG. Same fix as (1): one `unzip -p` per entry, with the name passed through `-p` after `--`.

3. **Malformed layer content gives a 500, not a 400, and the cue document is never validated** — `synced-epub-books.ts:92,94`. `JSON.parse(... ) as ReaderCues` and `as { text?: string }` are unchecked casts. `isReaderManifest` (`synced-epub.ts:61-64`) only checks `format`, `book` and `chapters`, so chapters without `title`, `cues`, `audio` and so on pass. Truncated JSON throws SyntaxError. A cue document without a `cues` array throws TypeError in `syncMapFromCues` (`synced-epub.ts:30`). `Math.min(...cues.map(...))` on a huge chunk can overflow the stack. The route only maps `EpubImportError` and `PdfBookInputError` to 400 (`upload-routes.ts:141-143`), so all of these return 500. The book is still cleaned up, so this is a robustness issue, not a leak. Fix: wrap the per-chapter read and parse in a try that throws `EpubImportError("Chapter N of the read-along layer is unreadable")`, and guard `Array.isArray(doc.cues)` and the cue tuple shape.

4. **Decompression is unbounded for audio** — `synced-epub-books.ts:113`. The cue and text reads are capped at 64 MB (`maxBuffer`), but the audio extraction has no size limit. A deflate bomb in an audio entry fills the disk, and the cleanup only happens afterwards. `unzip -Z` can report uncompressed sizes up front. Sum them for the audio entries and refuse past a bound, or check that against the upload cap. This sits behind a loopback-by-default server, so it is medium at most.

## Low

5. **The narration the file carries is only half restored for a bilingual EPUB** — `synced-epub-books.ts:134-138` and `synced.ts:55-59`. For an `epub-bilingual` file only the original-language audio is imported, but `documentFormatOf` marks the document `epub-bilingual` and the narration is stored as `{ original: lane, translation: null }`, so the Phone page shows no translation voice even though the EPUB has one. Probably acceptable (the chapters are the original text), but worth a line in docs/shelf.md "Books that were made elsewhere".

6. **Imported done chapters have no `synthesizedWith`** — `synced-epub-books.ts:122-132`. Rows are `status: "done"` with `audioPath` and `durationMs` but no `synthesizedWith`, so the chapter table's voice column and the "not the current voice" filter treat them as unknown/older audio. A later re-export gets `voice: null` for them (`assemble-document.ts` `voice: ch.synthesizedWith?.voice ?? null`) and the shelf loses the voice name that the first import's `laneFromRecordings` also lacks (`voice: null` at line 134). The book's own `voice: "kokoro:af_heart"` (line 150) is then a guess that a later "Synthesize" of the suspended chapters will use, mixing voices. Consider `voice: null` on the book, or reading the voice from the manifest if the layer carries one.

7. **Audio is stored twice** — the audio is extracted to `ch###.m4a` and the EPUB (which contains the same audio) is also kept as the shelf document (`:125`). Intended by design, but it doubles disk use for each imported book. A line in docs would do.

8. **`rename` across directories can fail with EXDEV** — `synced-epub-books.ts:115,125`. `uploads/<id>/source.epub` to `output/<id>/` and `tmp/<id>/import` to `output/<id>/` are renamed with `fs.rename`. They share `DATA_DIR` so are on one volume normally, but a Docker deployment that mounts `uploads`, `tmp` or `output` separately would fail with EXDEV. Fall back to copy + unlink on EXDEV, or stage inside `outDir`.

9. **The moved EPUB is gone from `uploads/<id>/source.epub`** — `:125`. AGENTS.md says an ebook's original is kept as `uploads/{bookId}/source.epub` for re-import; this path breaks that for synced imports (the file is now the shelf document). Not a bug; mention it in AGENTS.md if intended.

10. **Dead state if the process dies mid-import** — nothing outside `output/<id>`, `tmp/<id>` and `uploads/<id>` is written, and `deleteBook` (`lib/delete-book.ts`) removes all three, so the route's error path leaves nothing behind. A hard crash between the audio extraction and the insert leaves directories with no book row (same as the existing ebook path; no fix needed).

11. **`PUBLIC_ORIGIN` is not validated** — `env.ts:40`, `lib/shelf-address.ts:6-13`. An invalid value is silently ignored and the machine falls back to the interface address, with no log line, so a typo in a proxy deployment would silently bring back the container hostname and LAN address. A path in the origin (`https://x/shelf`) is dropped by `url.origin`. Validate at boot (`z.string().url().optional()` or a warning) and log which address was chosen.

12. **`loopbackOnly` with `PUBLIC_ORIGIN`** — `routes/phone.ts:27-28`. Overriding `loopbackOnly` for `via === "internet"` is intended (proxy to loopback), but it also hides the "this server listens on this machine only" warning when `PUBLIC_ORIGIN` is set but the proxy is not actually in front. Acceptable; documented in the comment.

## Verified non-issues

- Path escape: `layerEntryPath` can yield `../x`, but the result is only used for `entries.has` and `unzip` member names, never joined onto disk. Destination names are `ch%03d` + `path.posix.extname(...)` under `bookOutputDir(bookId)` (extname cannot contain `/`), and the document name goes through `safeName` (`basename` plus a character filter). Nothing can write outside the book's dirs or into another book's.
- Memory: only `book.json`, cue documents and text documents are read into memory (64 MB cap each). Audio goes from unzip to disk.
- Empty `chapters`: `imported.every(...)` is true for an empty array, so it throws `EpubImportError` (400).
- Narrated chapters whose cues or audio are missing from the zip become suspended rows with the carried text, and a doc with cues but no audio is treated as unnarrated.
- Part 1 alignment: `recordings.push` in `assemble-document.ts` sits in the same loop iteration as `readaloudChapters.push` (the skip `continue` precedes both), so they are aligned. The language branch assigns the lane to `translation`, original to `original`. The bilingual path computes lanes from the same `options` that produced the file. Filename regex checked by hand against `original`, `original-<lang>`, `<lang>`, `none`, each with and without `_pages`.
- Sweep: the backfill is wrapped in try/catch and runs before the probe, so a throw cannot stop stranded-job recovery. It processes each row once (an empty lane still stores a non-null object), so it does not repeat. It does read every un-narrated sync map serially at boot; fine for a shelf-sized table.
- `machineName()` is the only remaining `os.hostname()` use, and it is the fallback. Pairing `via`, `machine`, and the pair link all go through `shelfAddress()`/`machineName()`.
- Project rules: no `any`, no `!`, unions and `satisfies`-style typing used, no new `className` off the spacing ladder or raw colours in `PhonePage.tsx`.

## Test gaps

- No test for a crafted archive: duplicate basenames, an entry with glob characters, a manifest pointing at a missing cue or audio entry, and truncated cue JSON (findings 1 to 3). `synced-epub-books.test.ts` has three tests: manifest detection, one happy-path import, and refusing a plain EPUB.
- No test for the route (`/upload/ebook`) branch: that a synced EPUB takes the new path and an error deletes the book.
- No test that `PUBLIC_ORIGIN` overrides `via`/`machine` in `phone.test.ts`/`shelf-routes.test.ts` with an invalid value (finding 11).
- `bilingualLanesFromFilename` has a test, but not for a title that itself contains `_audio-`; the first match would win.
