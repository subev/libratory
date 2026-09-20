# Synthetic Books API

Plain JSON HTTP endpoints for creating books and chapters from scripts and other projects — no tRPC client needed. The server does no AI work here: callers send finished chapter text (summarize/generate however you like) and the app handles storage, TTS, assembly, translations, search indexing, and exports.

Base URL: the API server (default `http://localhost:3034`). Optional `x-profile-id` header scopes the book to a profile (same convention as the web app; omitted → default profile).

Limits: 500 chapters per request (append for more), 5M chars per chapter text, 32MB request body.

## POST /api/books

Create a synthetic book (`kind: "api"`), optionally with chapters in the same call.

```json
{
  "title": "Hacker News Top 10 — Aug 10, 2026",
  "client": "hn-top10",
  "folderId": "<uuid, optional>",
  "voice": "<voice id, optional — validated, defaults like the web app>",
  "speed": 1.0,
  "language": "<ISO code, optional — detected from the text when omitted>",
  "synthesize": false,
  "chapters": [
    { "title": "Story one", "text": "Chapter text…", "url": "https://example.com/article" }
  ]
}
```

- `client` — free-form identifier of the calling script; stored in `books.origin` and chapter sources.
- `chapters[].url` — optional; when present the chapter gets a `{kind:"url"}` source and the UI renders a "source ↗" link; the read-along reader and a synced EPUB export carry the same link (`link` in `docs/read-along.md`). Without it the source is `{kind:"api"}`.
- `language` — the language of the text (`en`, `bg`); left out, it is detected locally from the chapters sent with the book, and stays empty when there is too little text to tell. It is what the chat and the reading surfaces key off.
- `synthesize: false` (default) — chapters arrive **suspended** for review in the web UI, like digest chapters.
- `synthesize: true` — chapters are queued straight to TTS with the book's voice (API text is normalized inline at insert — no worker roundtrip); poll `GET /api/books/:id` for audio readiness.

Response `201`:

```json
{ "id": "<bookId>", "title": "…", "chapters": [{ "id": "…", "index": 0, "title": "Story one" }] }
```

`400` with `{ "error": … }` (and `issues` for validation failures).

## POST /api/books/:bookId/chapters

Append chapters to an existing book (any kind — appending to a PDF book tags them as inserted, so re-extraction/redetection preserves them). Body: `{ client?, chapters: [...], synthesize? }` — same chapter shape and semantics as above. Chapters are appended after the highest existing index. Response `201` like create; `404` if the book doesn't exist.

## GET /api/books/:bookId

Status poll for scripts:

```json
{
  "id": "…", "title": "…", "kind": "api", "status": "pending", "outputReady": false,
  "chapters": [
    { "id": "…", "index": 0, "title": "…", "status": "done", "error": null, "durationMs": 812345, "hasAudio": true }
  ]
}
```

The API comfortably handles bulk imports — e.g. a scraped blog archive as one book with 1,500+ chapters (one per article), created with one `POST /api/books` and a few appends, batched to stay under the request caps. Importers for personal content live in their own repos next to the scraper that produces the files; this repo only hosts generic consumers.

## Example consumer: scripts/hn-top10.mjs

Builds a podcast-style book from a day's top Hacker News stories — one chapter per story, written in an American network-news register: a clipped anchor slug (weekday + that day's rank), a curiosity hook, the headline revealed as the hook's payoff, then the story, with the community reaction explicitly signposted and capped at ~20% of the chapter:

```sh
node scripts/hn-top10.mjs                                  # today's top 10, chapters suspended for review
node scripts/hn-top10.mjs --date 2026-08-09                # any past day (hckrnews archives)
node scripts/hn-top10.mjs --from 2026-08-04 --to 2026-08-08  # overall top 10 across the range (catch-up)
node scripts/hn-top10.mjs --from 2026-08-04 --to 2026-08-08 --count 5 --per-day  # top 5 of each day
node scripts/hn-top10.mjs --synthesize --count 5           # queue TTS immediately
```

Chapters play in day order, biggest story first within each day, in both selection modes; they are titled "Aug 8 #1 — Story title" ("#1 — Story title" for a single-day book) so the day and the rank survive into the player. Rank is the story's true position among everything hckrnews saw that day, so it stays honest in overall-top-N mode where a day may contribute its #1 and its #7. Each chapter is told the weekday, the rank, the day's story count and a rotating hook approach (four of them, cycled by position) so a 36-chapter run doesn't converge on one house opening. Stories that fail to summarize are skipped with a log line instead of failing the whole run; `--concurrency` (default 5) controls parallel summaries. `--list --json` emits the selection as a JSON array (progress on stderr) — this backs the web modal's "Preview stories" list (`GET /scripts/hn-top10/preview`), where each story links out and can be unchecked; the build then passes the deselected ids via `--exclude`.

Needs `DEEPSEEK_API_KEY` (env or root `.env`) since the summarization runs in the script, not the server, plus the workspace-root deps (`pnpm install`). Story lists come from [hckrnews.com](https://hckrnews.com/) and replicate its "top 10" tab exactly: the site groups stories into UTC days (archived at `/data/YYYYMMDD.js` — one file is one day group) and shows each group's top N by points. For days not yet archived the group is reconstructed from `latest.js` plus the server-rendered homepage, cut by UTC date. Any historical day works even after stories drop off the HN front page (`--list` prints a day's top stories without creating anything, verified 1:1 against the site's top-10 view); comments come from the Algolia HN API. Article text is extracted with [Defuddle](https://github.com/kepano/defuddle) + linkedom (falls back to title + discussion when a site blocks fetching).
