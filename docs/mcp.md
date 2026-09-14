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

For a hands-on flow instead: `upload_book` with `skipSynthesis: true`, inspect `get_book`, fix a chapter with `get_chapter` / `set_chapter_text`, then `synthesize_book` and `assemble_book` (which waits for chapters still narrating by default). `upload_book` with `fullExtract: false` gives an instant text-only book — readable and searchable in seconds, chapters only after `extract_chapters`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_books` | Books newest first with status, chapter counts and whether the M4B exists. Optional `folderId`. |
| `upload_book` | Create a book from absolute PDF paths on the machine running Libratory (copied in). Options: `title`, `voice`, `speed`, `language`, `folderId`, `fullExtract` (default true), `skipSynthesis`, `llmChapterDetection` + `chapterModel`, `ocrEngine`. |
| `get_book` | Status, error, files, chapters (no text), assembled audiobooks and exported documents with download paths. |
| `wait_for_book` | Block until `until` is reached — `text`, `chapters`, `audio` or `output` — or `timeoutSeconds` (default 50, max 600) passes. Returns early on failure; `output` also waits for narration still running and a queued assembly. |
| `get_book_logs` | The processing log, oldest first; `after` for only newer entries. |
| `get_chapter` | The text the narrator reads (edited, else cleaned, else raw) with `offset`/`maxChars` paging. |
| `set_chapter_text` | Replace the narrated text of a chapter; extraction is kept. |
| `extract_chapters` | Full extraction of a text-only book: thorough page read plus chapter detection. |
| `redetect_chapters` | Detect chapters again, optionally with an AI model reading the table of contents. Replaces chapters and audio. |
| `synthesize_book` | Narrate every selected chapter with the book's voice. |
| `synthesize_chapter` | Narrate one chapter again. |
| `assemble_book` | Build the M4B from narrated chapters; `waitForAll` (default true) waits for chapters still narrating. |
| `export_book` | `pdf`, `epub` or `epub-sync` document of the selected chapters, optionally of a translation. |
| `cancel_book` | Stop extraction and narration and clear queued jobs. |
| `search_library` | Search the text of every book; hits cite book, chapter and page. |

Results are JSON in the tool's text content. Errors come back as tool errors with the message the UI would show.

Paths in results are where the server sees them — in Docker that is inside the container. Download routes (`/download/:bookId`, `/download/assembly/:id`, `/download/document/:id`) serve the same files over HTTP.
