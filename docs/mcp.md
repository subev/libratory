# MCP server

The server is an [MCP](https://modelcontextprotocol.io) server at `/mcp` (Streamable HTTP, stateless), on the same port as the UI — `http://localhost:3034/mcp` for the desktop app and the default dev server. Any MCP client can use it; no separate process, package or API key.

```sh
claude mcp add --transport http libratory http://localhost:3034/mcp   # Claude Code
```

Cursor, Codex, Claude Desktop and the rest take the same URL in their MCP settings. Optional `x-profile-id` header scopes every tool to a profile, like the web app; requests from a Host that is neither loopback, an IP literal nor listed in `TRUSTED_HOSTS` are refused (DNS rebinding), the same policy the browser routes apply to Origin.

The books, chapters, files and outputs the tools return are the same rows the UI shows, so a person can watch or take over in the app at any point.

## The workflow

Every long job returns immediately with the book's state; `wait_for_book` is how a caller blocks on it.

```
upload_book   { paths: ["/Users/me/Downloads/dune.pdf"] }
              → extraction, chapter detection, narration of every chapter and M4B assembly run unattended
wait_for_book { id, until: "output" }
              → { satisfied: true, book: { outputPath: ".../Dune_….m4b", chapters: [...] } }
```

Call `wait_for_book` again when it times out — the work keeps running. Its default of 50 seconds sits under the 60-second request limit most MCP clients apply; raise `timeoutSeconds` (up to 600) only where the client allows longer calls, or when it resets its limit on the progress notifications the tool sends. A 300-page book takes tens of minutes on an Apple Silicon Mac: the thorough page read is the slow part, narration is roughly 10x realtime.

For a hands-on flow instead: `inspect_pdf` first, `list_voices` for the language, `upload_book` with `skipSynthesis: true`, read `get_book_text` to judge the OCR, `cleanup_chapters` or `update_chapter` to fix what it got wrong, then `synthesize_book` and `assemble_book` (which waits for chapters still narrating by default). `upload_book` with `fullExtract: false` gives an instant text-only book — readable and searchable in seconds, chapters only after `extract_book`.

## Tools

| Tool | What it does |
| --- | --- |
| `get_capabilities` | Hardware (MLX/CUDA), model bundles with installed/downloading state, OCR engines (`llm` is marked `cloud` and `available` only when an AI provider key is set), the language packs installed or downloading (plus how many more exist), Pocket TTS languages, which cloud keys are configured. |
| `start_download` | Fetch a missing bundle, a Tesseract language pack by pack or ISO code, or a Pocket language; watch `get_capabilities`. |
| `list_voices` | Every usable narrator voice with its language: Kokoro, Pocket TTS, the MLX narrators, installed macOS voices, and Cartesia/ElevenLabs when a key is set. Filter by `language` or `engine`. |
| `inspect_pdf` | Page count, text layer or scan, language guess, word count and author of a PDF before uploading it. |
| `list_books` | Books newest first with status, chapter counts and whether the M4B exists. Optional `folderId`. |
| `upload_book` | Create a book from absolute PDF paths on the machine running Libratory (copied in). Options: `title`, `voice`, `speed`, `language`, `folderId`, `fullExtract` (default true), `skipSynthesis`, `llmChapterDetection` + `chapterModel`, `ocrEngine` (`tesseract`, `surya`, or `llm` for a cloud vision model) + `ocrModel`. Refuses full extraction while the models are not installed. |
| `get_book` | Status, latest log line, files, chapters with narration progress (no text), assembled audiobooks and exported documents with download paths. |
| `wait_for_book` | Block until `until` is reached — `text`, `chapters`, `audio` or `output` — or `timeoutSeconds` (default 50, max 600) passes. Returns early on failure; `output` also waits for narration still running and a queued assembly. |
| `get_book_logs` | The processing log, oldest first, including OCR page and narration chunk progress; `after` for only newer entries. |
| `get_book_text` | The raw or OCR'd text of one file, independent of chapters — check OCR quality before narrating. Paged. |
| `get_chapter` | The text the narrator reads (edited, else cleaned, else raw) with `offset`/`maxChars` paging. |
| `update_chapter` | Title, narrated text, or selection of a chapter. |
| `set_book_settings` | Voice, speed, language, author, OCR engine and its vision model (`ocrModel`), AI chapter detection after upload. |
| `extract_book` | Run or redo the full extraction; `ocrEngine` (and `ocrModel`) reads the pages again with another engine. |
| `redetect_chapters` | Detect chapters again from the extracted pages, optionally with an AI model reading the table of contents. Does not re-read pages. |
| `cleanup_chapters` | AI repair of OCR artifacts (split words, stray hyphens, page furniture) into the narrated copy, for all selected chapters or `chapterIds`. |
| `synthesize_book` | Narrate every selected chapter, or `chapterIds`; `resume` continues an interrupted chapter from its finished chunks. |
| `assemble_book` | Build the M4B from narrated chapters; `waitForAll` (default true) waits for chapters still narrating. |
| `export_book` | `pdf`, `epub` or `epub-sync` document of the selected chapters, optionally of a translation. |
| `cancel_book` | Stop extraction and narration and clear queued jobs. |
| `search_library` | Search the text of every book; hits cite book, chapter and page. |

Results are JSON in the tool's text content. Errors come back as tool errors with the message the UI would show.

A non-English scan needs its Tesseract pack, and full extraction needs the Marker/Surya bundle: `get_capabilities` says which are missing and `start_download` fetches them, so an agent on a fresh install can bootstrap itself. The `llm` OCR engine needs neither to read — it sends page images to a cloud vision model — but it does need an AI provider key, and the book's Tesseract pack is what places its words on the page for search and highlighting; `get_book_logs` names the pages it read short of the local OCR even after a second look, and how much of each page it could place.

Paths in results are where the server sees them — in Docker that is inside the container. Download routes (`/download/:bookId`, `/download/assembly/:id`, `/download/document/:id`) serve the same files over HTTP.
