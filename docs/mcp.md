# MCP server

The server is an [MCP](https://modelcontextprotocol.io) server at `/mcp` (Streamable HTTP, stateless), on the same port as the UI — `http://localhost:3034/mcp` for the desktop app and the default dev server. Any MCP client can use it; no separate process, package or API key.

```sh
claude mcp add --transport http libratory http://localhost:3034/mcp   # Claude Code
```

Cursor, Codex, Claude Desktop and the rest take the same URL in their MCP settings.

**Profiles and folders go by name.** A connection works in the Default profile unless it was added with a header — `claude mcp add --transport http libratory http://localhost:3034/mcp --header "x-profile-id: <uuid>"` — and either way the tools that place or list things (`list_books`, `upload_book`, `create_book`, `search_library`, `save_note`, `list_notes`) take `profile`, a name or an id, for that one call. `list_books` names the profiles and the folders. A `folder` is a path of names from the top level (`Work/Contracts`) or an id; placing a book in a path that does not exist creates it, filtering by one does not. Requests from a Host that is neither loopback, an IP literal nor listed in `TRUSTED_HOSTS` are refused (DNS rebinding), the same policy the browser routes apply to Origin.

The books, chapters, files and outputs the tools return are the same rows the UI shows, so a person can watch or take over in the app at any point.

## The workflow

Every long job returns immediately with a summary of the book; `wait_for_book` is how a caller blocks on it. The summary is counts — files with and without text, chapters by status, and in detail only what failed — because an agent pays for every token of a result and polls in loops. `get_book` is the one call that lists every chapter with its id.

```
upload_book   { paths: ["/Users/me/Downloads/dune.pdf"] }
              → extraction and chapter detection run; the chapters then wait to be looked at
wait_for_book { id, until: "chapters" }
              → { satisfied: true, book: { chapters: { total: 48, byStatus: { suspended: 48 } }, … } }
synthesize_book { id }  →  assemble_book { id }  →  wait_for_book { id, until: "output" }
```

Narration is a decision taken after the chapters have been seen, not a consequence of the upload: a wrong
boundary narrated is an hour wasted. `upload_book` with `skipSynthesis: false` runs the whole pipeline
unattended instead — narration of every chapter and one M4B, `wait_for_book` until `"output"`.

Call `wait_for_book` again when it times out — the work keeps running. Its default of 50 seconds sits under the 60-second request limit most MCP clients apply; raise `timeoutSeconds` (up to 600) only where the client allows longer calls, or when it resets its limit on the progress notifications the tool sends. A 300-page book takes tens of minutes on an Apple Silicon Mac: the thorough page read is the slow part, narration is roughly 10x realtime.

For a hands-on flow: `inspect_pdf` first, `list_voices` for the language, `upload_book`, read `get_book_text` to judge the OCR, `cleanup_chapters` or `update_chapter` to fix what it got wrong, then `synthesize_book` and `assemble_book` (which waits for chapters still narrating by default). `upload_book` with `fullExtract: false` gives an instant text-only book — readable and searchable in seconds, chapters only after `extract_book`.

### A library to ask questions of

```
upload_book   { paths: [...17 PDFs], title: "Kindergarten rules", fullExtract: false, profile: "Tedi", folder: "School" }
wait_for_book { id, until: "searchable" }     → scanned files are OCR'd and the index has caught up
search_library { query: "…", profile: "Tedi", folder: "School" }
save_note     { bookId, title: "When may a sick child return?", markdown: "… (Правилник, чл. 23, стр. 9)" }
```

`"text"` is reached when every file has been read — OCR of the scanned ones included — not when the first one has; `"searchable"` when that text is indexed. Input is PDF only: text held in any other form (a web page, markdown, a converted .docx) goes through `create_book`, one chapter per entry, which is searchable at once and can be narrated like any other book. `list_notes` is where a later session finds what an earlier one worked out.

## Tools

| Tool | What it does |
| --- | --- |
| `get_capabilities` | Hardware (MLX/CUDA), model bundles with installed/downloading state, OCR engines (`llm` is marked `cloud` and `available` only when an AI provider key is set), the language packs installed or downloading (plus how many more exist), Pocket TTS languages, which cloud keys are configured. |
| `start_download` | Fetch a missing bundle, a Tesseract language pack by pack or ISO code, or a Pocket language; watch `get_capabilities`. |
| `list_voices` | Every usable narrator voice with its language: Kokoro, Pocket TTS, the MLX narrators, installed macOS voices, and Cartesia/ElevenLabs when a key is set. Filter by `language` or `engine`. |
| `inspect_pdf` | Page count, text layer or scan, language guess, word count and author of a PDF before uploading it. |
| `list_books` | The profiles (current one marked), this profile's folders as paths with book counts, and the books newest first with status, chapter counts and whether the M4B exists. `profile`, `folder`, `query` (title words), `limit` (default 100; `truncated` says when it cut). |
| `upload_book` | Create a book from absolute PDF paths on the machine running Libratory (copied in). Options: `title`, `voice`, `speed`, `language`, `profile`, `folder`, `fullExtract` (default true), `skipSynthesis` (default true; false narrates and assembles unattended), `llmChapterDetection` + `chapterModel`, `ocrEngine` (`tesseract`, `surya`, or `llm` for a cloud vision model) + `ocrModel`. Refuses full extraction while the models are not installed. |
| `create_book` | Create a book from text the caller holds — `title` and `chapters` (`title`, `text`, optional `url` kept as the source link); `appendTo` adds chapters to an existing book instead. `profile`, `folder`, `voice`, `speed`, `language` (detected when omitted), `synthesize` to start narration at once, `client` to name the writer. |
| `get_book` | Everything about one book: status, latest log line, files, every chapter with id and narration progress (no text), assembled audiobooks and exported documents with download paths, saved notes. `logs: true` adds the processing log — OCR pages, narration chunks, failures — and `logsAfter` only its newer part. |
| `wait_for_book` | Block until `until` is reached — `text`, `searchable`, `chapters`, `audio` or `output` — or `timeoutSeconds` (default 50, max 600) passes; answers with the summary. Returns early on failure, and with `satisfied: false` when nothing is left to run and no file yielded text; `output` also waits for narration still running and a queued assembly. |
| `get_book_text` | The raw or OCR'd text of one file, independent of chapters — check OCR quality before narrating. Paged. |
| `get_chapter` | The text the narrator reads (edited, else cleaned, else raw) with `offset`/`maxChars` paging. |
| `update_chapter` | Title, narrated text, or selection of a chapter. |
| `set_book_settings` | Title, `folder` (moves the book; `null` for the top level), voice, speed, language, author, OCR engine and its vision model (`ocrModel`), AI chapter detection after upload. A rename, a move or an author change answers with the `undo` call that reverses it. |
| `manage_folder` | `create` a folder path, `rename` one, or `move` it under another (`parent: null` for the top level). Never deletes. |
| `extract_book` | Run or redo the full extraction; `ocrEngine` (and `ocrModel`) reads the pages again with another engine. |
| `redetect_chapters` | Detect chapters again from the extracted pages, optionally with an AI model reading the table of contents. Does not re-read pages. |
| `cleanup_chapters` | AI repair of OCR artifacts (split words, stray hyphens, page furniture) into the narrated copy, for all selected chapters or `chapterIds`. |
| `synthesize_book` | Narrate every selected chapter, or `chapterIds`; `resume` continues an interrupted chapter from its finished chunks. |
| `assemble_book` | Build the M4B from narrated chapters; `waitForAll` (default true) waits for chapters still narrating. |
| `translate_book` | A second version of the selected chapters (or `chapterIds`) beside the original: `language` by its English name (`German`), a rewrite `preset` (`eli5`, `shorten`, `summary`, `enrich`), or a `prompt` with an optional `label`. Each chapter goes through the AI model; `get_book` lists the versions under `variants`. |
| `export_book` | `pdf`, `epub` or `epub-sync` document of the selected chapters; `language` names a finished version from `variants` instead of the original. |
| `cancel_book` | Stop extraction and narration and clear queued jobs. |
| `search_library` | Search the text of every book; hits cite book, chapter and page. `profile`, `folder` (that folder and everything inside it), `limit`, `mode`. |
| `save_note` | Keep an answer or analysis as a note (markdown): on a book's Notes tab with `bookId`, otherwise a library note in the profile. `author` names the writer. |
| `list_notes` | Notes newest first — titles only — for a `bookId` or the profile's library notes; `noteId` reads one, paged. |

Results are JSON in the tool's text content. Errors come back as tool errors with the message the UI would show.

A non-English scan needs its Tesseract pack, and full extraction needs the Marker/Surya bundle: `get_capabilities` says which are missing and `start_download` fetches them, so an agent on a fresh install can bootstrap itself. The `llm` OCR engine needs neither to read — it sends page images to a cloud vision model — but it does need an AI provider key, and the book's Tesseract pack is what places its words on the page for search and highlighting; `get_book` with `logs: true` names the pages it read short of the local OCR even after a second look, and how much of each page it could place.

Paths in results are where the server sees them — in Docker that is inside the container. Download routes (`/download/:bookId`, `/download/assembly/:id`, `/download/document/:id`) serve the same files over HTTP.
