# Library search & chat — how the indexing/retrieval mechanism works

Shipped 2026-08-09. This is the deep-dive companion to the short "Library Chat & Search Index" section in AGENTS.md — written for both humans and agents who need to understand, debug, or extend the system.

## The problem it solves

The library holds ~527 books ≈ 217M characters ≈ 60–90M tokens of extracted text (English + Bulgarian). DeepSeek's context window is 1M tokens, so "paste the book into the prompt" (what Ask AI does per book) is off by two orders of magnitude at library scale. Every solution reduces to: **find the few relevant passages first, let the LLM read only those.** That "finding" layer is the search index; the AI layer on top is the chat.

## The two AI surfaces (don't confuse them)

| | **Assistant search** (the docked panel, `POST /assistant`) | **Ask AI** (the assistant's `analyze_text` tool, behind a card) |
|---|---|---|
| How it reads | Agentic retrieval: the model iteratively calls search tools over the index | The *entire* scope text (book raw text or selected chapters) is stuffed into context |
| Best at | Pointed questions, "where does it say…", cross-book questions, follow-ups | Whole-book analysis: summaries, themes, characters — anything needing every word |
| Citations | Yes — verified, click-through to PDF page / chapter / translation | No (there are no chunk ids in stuffed mode) |
| Turns | Multi-turn conversation | The pinned text stays under the composer; every follow-up reads it again |
| Scope | Whole profile, folder subtree, or one book | One book's raw text, or a chapter selection |
| Notes | "Save as note" on demand (`notes.saveLibraryAnswer`, `bookId NULL`) | Every answer auto-saved as a note on the book, and drawn as one in the thread |

Both stream over AI SDK UI-message streams from raw Fastify routes (`chat-routes.ts`, `assistant-routes.ts`) — tRPC can't stream, so these are the same carve-out as uploads/PDF serving. `POST /chat` was the library chat page's route until 2026-09-25, when that page became the assistant full width; the route and its tests stay as the search half's own harness, and the assistant reuses its tools (`buildChatTools`) and citation verification.

## The index: `book_chunks`

One table carries three retrieval systems (see `schema.ts`):

- **The rows** — every text unit in the library, split into ~1,400-char chunks:
  - `source`: `raw` (a `book_files.raw_text`, the pdftotext output — the primary corpus; most books are raw-only), `chapter` (effective chapter text: `customText ?? cleanText ?? rawText` — same precedence rule as synthesis), or `translation` (`chapter_translations.text`, `status = 'done'` only).
  - Exactly one of `bookFileId` / `chapterId` / `translationId` matches `source` (translations also carry `chapterId` for grouping).
  - `seq` orders chunks within their unit; `charStart`/`charEnd` are **true offsets into the unit's original text** — this is what lets neighboring chunks be merged without duplicating their overlap.
  - `pageStart`/`pageEnd`: for raw chunks, real PDF page numbers; for chapter chunks with marker `sourceBlocks`, real per-chunk pages from the block map; otherwise (blockless chapters, translations) the chapter's page range.
  - `profileId`/`folderId` are **denormalized** from `books` so scope filters hit an index instead of a join; refreshed whenever the book is re-indexed.
  - `sourceHash`: sha256 of the unit's full text at chunking time — the cheap "did anything change?" check.
- **GIN index on `tsv`** — full-text search. `tsv` is a generated column (`to_tsvector('simple', text)`): Postgres maintains it automatically on every insert/update; we never write it. The GIN index is an inverted index — a map from each word to the chunks containing it, like the index at the back of a book.
- **HNSW index on `embedding`** — semantic search. `embedding vector(1024)` holds the BGE-M3 vector; HNSW is a multi-layer "skip-list of neighborhoods" that finds nearest vectors by touching hundreds of rows instead of all 208K. `vector_cosine_ops` = organize by angle (the standard for text embeddings). HNSW ignores NULLs, so half-embedded books cost nothing.
- Plain btrees on `bookId`, `profileId`, `(bookFileId, seq)`, `(chapterId, seq)` for exact/neighbor lookups.

### Why `'simple'` FTS config, no stemmer, no unaccent

Postgres has no Bulgarian stemmer, and the English stemmer mangles Cyrillic unpredictably. `'simple'` = lowercase + split, identical treatment for every language, nothing mangled. The cost: no stemming (`богатство` won't FTS-match `богатствата`). Two mitigations: the embedding side is completely ending-agnostic, and `pg_trgm` is installed as a future fallback (trigram similarity survives inflections and typos; add a `gin (text gin_trgm_ops)` index + a zero-FTS-hits fallback if needed). `unaccent()` was skipped because Bulgarian barely uses diacritics and the function isn't `IMMUTABLE` (can't sit in a generated column without a wrapper).

## Chunking (`lib/search-chunks.ts`)

- `chunkPagedText(rawText)` for pdftotext output: `\f` form feeds separate pages (they survive extraction — **do not strip `\f` in `lib/pdf-raw-text.ts`**, page citations depend on them). Builds an offset→page map, then packs paragraphs (`\n\s*\n` or `\f` separated) into ~1,400-char chunks, sentence-splitting oversized paragraphs.
- ~15% **overlap**: each chunk's start is extended backward to a sentence boundary inside the previous chunk (≤250 chars), so a retrieval hit keeps its lead-in context. Overlap regions keep true offsets — the chunk text is always exactly `unitText.slice(charStart, charEnd)` with `\f→\n`.
- `chunkPlainText(text, pageStart?, pageEnd?, pageOf?)` for chapters/translations: same packing; unit-level page range, unless a `pageOf` offset→page map is given. For marker-extracted chapters, `pageMapFromBlocks` builds that map from `chapters.sourceBlocks` (each block carries its PDF page; blocks are located by 64-char prefix in order, unmatched ones skipped) — so chapter chunks get real pages too. The unit's `sourceHash` is salted (`pages:v1`) when a map exists, forcing a one-time re-chunk of previously indexed chapters.

## Embeddings (`lib/embeddings.ts` + `scripts/embed_bge_m3.py`)

**What an embedding is:** a small neural net (BGE-M3, 568M params, MIT license, ~2.2GB) reads text and outputs 1,024 numbers — a coordinate in "meaning space" where similar meanings land close together *across languages* (an English sentence and its Bulgarian translation measure ~0.93 cosine similarity). Search = embed the query, fetch nearest chunks. Everything runs locally; no text leaves the machine.

**The runner:** a lazy singleton Python child process (same conda env and spawn pattern as kokoro TTS: `HF_HUB_OFFLINE=1`, `PYTORCH_ENABLE_MPS_FALLBACK=1`), speaking JSON-lines over stdin/stdout: `{id, texts[]} → {id, vectors[][]}` (dense, normalized). Model load takes seconds — hence long-lived, with idle-kill after 5 min and restart-on-crash. Timeouts: 5 min per batch (indexing), 20s per query (chat). **Graceful degradation:** if the embedder is down/slow, `embedQuery()` returns null and search runs FTS-only — the chat tool tells the model so, and nothing blocks.

## Hybrid retrieval (`lib/search.ts`)

One SQL statement runs both search systems and fuses them:

1. **FTS leg**: `websearch_to_tsquery('simple', query)` ranked by `ts_rank_cd`, top 50.
2. **Vector leg**: `embedding <=> $queryVector` (cosine distance) via HNSW, top 50. `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` keeps recall up when profile/book filters discard graph neighbors.
3. **RRF fusion** (`FULL OUTER JOIN` on chunk id): each chunk scores `1/(60+rank)` from each list it appears in, summed. Rank-based fusion sidesteps the incomparable-scores problem (an FTS rank and a cosine distance live on unrelated scales); a chunk both systems agree on beats either system's solo favorite; the constant 60 (from the original RRF paper) stops rank 1 from steamrolling consensus.

Then `groupHits()` tidies in JS — the same passage can legitimately exist 3+ times in the index (raw text, extracted chapter, N translations):

- Group by `chapterId ?? bookFileId ?? bookId`; keep ≤2 passages per group, and a second one only if its char range doesn't overlap the first (a different passage, not the cleaned/translated twin).
- **Language preference**: when a group's top hit and a close-scoring twin (≥80% of its score) differ in script, prefer the one matching the query's script (Cyrillic-ratio heuristic) — ask in Bulgarian, see the Bulgarian text.
- **Raw-vs-chapter dedup**: a raw hit whose page range overlaps a chapter/translation hit from the same book is dropped (the chapter version is cleaner and titled), but the surviving hit inherits the raw chunk's precise `pageStart`/`pageEnd` — chapter chunks only carry the whole chapter's range, the raw twin pins the passage to its actual pages. Works in both score orders: chapter-first narrows in place, raw-first swaps in the chapter twin.
- Cap 3 hits per book so one book can't monopolize results.

`expandPassage(chunkId, before, after)` fetches adjacent `seq` rows of the same unit and merges them using char offsets (overlap regions appear once). This powers the chat's `read_passage` tool.

Exposed as tRPC `search.library` (for testing/UI) and consumed directly by the chat tools.

## The agentic chat (`chat-routes.ts`, `lib/chat-tools.ts`, `lib/citations.ts`)

- **Loop**: AI SDK `streamText` with the OpenAI-compatible provider pointed at DeepSeek. Hard caps: `stopWhen: stepCountIs(8)` (it physically cannot search forever), 3-min abort signal, 4,096 max output tokens. `prepareStep` removes the tools on the last step (`activeTools: []`) and appends a user message saying the search rounds are spent, so the turn always ends with a text answer — without it a search-happy model burns all steps on tools and the stream closes silently with no answer. Declining the tools with `toolChoice: "none"` is not enough: DeepSeek V4 answers that by writing the calls it still wants as raw `<｜DSML｜…>` markup in the text.
- **Tools** (zod schemas): `search_library` (hybrid search within the request's profile/folder/book scope), `read_passage` (context expansion by citation id), `list_books` (titles only, for meta questions).
- **Citations — the id-catalog discipline** (borrowed from `toc-detect.ts`): every passage a tool returns is registered in a per-request `CitationCatalog` as `c_1, c_2…`. The system prompt requires inline `[c_N]` markers using only ids from tool output. After streaming, `verifySources()` parses the final text and keeps only catalog-known ids — **a hallucinated citation cannot render**. Verified sources ship as one `data-sources` part; the UI rewrites `[c_N]` → `[n]` and renders a source list (grouped by book; chapter, page and the passage's opening words per row): a cited passage of a narrated chapter → the reader at the moment it is spoken (`/books/:id/read?chapter=<index>&t=<ms>`, placed by `lib/citation-targets.ts` from the chunk's `charStart` and the chapter's sync map), with the PDF as a second button; otherwise raw → `PdfPreviewModal` (`/pdf/:fileId#page=N` — pages from the chunk), chapter → PDF page when resolvable via `sourceFileIndex`, else the book page; translation/variant → `/books/:bookId?variant=<key>`. The catalog is re-seeded from prior messages' `data-sources` parts so follow-up turns can cite earlier passages.
- **Persistence**: conversations are kept in Postgres (`chat_conversations` / `chat_messages`), listed behind the assistant panel's History button and reopened there with their messages, citations, sources and model. The server owns the transcript and the run: a request brings one question, the answer goes on when the tab is closed, and only Stop, deleting the conversation or the timeout ends it early. What a conversation searches is fixed at its first question. `AGENTS.md` ("Conversations") has the full contract. "Save as note" is still a separate, deliberate act → a `notes` row with `bookId NULL`, listed behind the sidebar's "Saved answers" (`notes.listLibrary`), untouched when a conversation is deleted.

## When indexing happens (the lifecycle)

**Two-pass design:** `indexBook` (chunk + FTS — seconds) chains `embedChunks` (vectors — seconds to minutes per book). **Keyword search works the moment pass 1 finishes**; semantic search strengthens as pass 2 fills in. Status lives in `books.search_index` jsonb: `queued → chunking → embedding → done` (or `failed` + error), with a `progress` counter — surfaced as the book-list badge ("indexing…" pulse → faint ✓, red "index failed") and the `/chat` coverage hint (`search.indexStatus`).

**Triggers** — `queueIndexBook(bookId)` (`lib/search-index.ts`) is called after *every* text-mutating completion:

| Event | Hook site |
|---|---|
| Upload finishes raw extraction | `workers/raw-extract.ts` |
| Marker extraction creates chapters | `workers/extract.ts` |
| Chapter re-detection | `workers/redetect.ts` |
| AI cleanup writes customText | `workers/cleanup.ts` |
| Translation completes | `workers/translate.ts` |
| Manual text edit / reset | `routes/chapters.ts` updateText/resetText |
| Digest book built | `workers/digest.ts` |
| Note appended as chapter | `routes/notes.ts` toChapter |

**Blanket re-queue is safe and cheap** because of per-unit hashing: `indexBook` compares each unit's `sourceHash` and skips unchanged units entirely (no re-chunk, no re-embed). Only the changed unit is deleted + re-chunked (in one transaction) + re-embedded. Callers don't need to know what changed. `jobKey: index:{bookId}` + `jobKeyMode: replace` collapses duplicate queueing. Book deletion needs nothing — FK cascades remove chunks.

**Backfill / manual re-index:** `pnpm backfill:index` queues every book whose status isn't `done` (add `--force` to redo everything, e.g. after changing the chunker or embedding model — note `--force` still hash-skips unless the chunker output changed; to truly rebuild, `TRUNCATE book_chunks` first).

## Crash safety (why interruptions don't matter)

Philosophy inherited from the rest of the app: every job runs `maxAttempts: 1` — *failures* stay failed for a human to review; *crashes* recover mechanically:

- `embedChunks` works in batches of 32 with per-row commits; its work list is `WHERE embedding IS NULL`, so a restart resumes exactly where it stopped (worst case: one batch redone).
- `indexBook` is idempotent via `sourceHash`.
- The startup sweep (`workers/sweep.ts`) deletes dead/locked index jobs and re-queues them as `indexBook` — so a job killed mid-run (server restart, crash) self-heals on next boot.
- The embedding python process is stateless; it just respawns.

## Operations & troubleshooting

Progress (read-only, safe anytime):

```sql
-- global
SELECT count(*) FILTER (WHERE embedding IS NOT NULL) || ' / ' || count(*) FROM book_chunks;
-- per book
SELECT title, search_index->>'status', search_index->>'progress', search_index->>'error'
FROM books WHERE search_index->>'status' != 'done';
```

Common situations:

- **A book stuck at `embedding` with no error** → its job died holding the lock before the sweep learned about index jobs, or the queue was manually cleared. Fix: `pnpm backfill:index` (re-queues non-done books only).
- **`failed` with an embedding error** → usually the python env (FlagEmbedding missing, model not cached — `scripts/setup.sh` installs both). Chat still works FTS-only meanwhile.
- **Chat says "Semantic search unavailable"** → the embedder timed out on that query (e.g. cold start >20s); the next query typically works.
- **Wrong/no page on a citation** → check the chunk has `page_start` (raw chunks only get pages if `\f` survived; chapter chunks get per-chunk pages only when `sourceBlocks` exist and still match the indexed text — cleaned/custom text can defeat the block prefixes, falling back to the chapter's range).

Disk cost (at 527 books / 208K chunks): `book_chunks` data ~1.9GB, HNSW ~1.6GB (it stores a second copy of every vector plus graph links), GIN ~150MB — DB total ~3.8GB vs ~150MB of original tables. One-time; grows ~5–10MB per typical new book.

## File map

| Concern | Files |
|---|---|
| Schema | `packages/server/src/schema.ts` (`bookChunks`, `SearchIndexJob`, nullable `notes.bookId`), migration `drizzle/0026_*.sql` (extensions + table) |
| Chunking | `packages/server/src/lib/search-chunks.ts` (+ test) |
| Embeddings | `packages/server/src/lib/embeddings.ts`, `scripts/embed_bge_m3.py` |
| Retrieval | `packages/server/src/lib/search.ts` (+ test), `routes/search.ts` |
| Index jobs | `workers/index-book.ts`, `workers/embed-chunks.ts`, `lib/search-index.ts`, sweep additions in `workers/sweep.ts`, `src/scripts/backfill-search-index.ts` |
| Chat backend | `packages/server/src/chat-routes.ts`, `lib/chat-tools.ts`, `lib/citations.ts` (+ test), `lib/ask-ai.ts` (+ test) |
| Chat frontend | `packages/web/src/components/assistant/{AssistantPanel,AssistantThread}.tsx`, `components/chat/{ChatSidebar,SourcePicker,SourceList,SavedAnswers}.tsx`, `lib/chat-message.ts` |
| Ask AI frontend | the Ask AI buttons on the book page pin to `components/assistant/context.tsx`; the card and note are `components/assistant/ActionCard.tsx` |
| Infra | `docker-compose.yml` (`pgvector/pgvector:pg17`), `scripts/setup.sh` (FlagEmbedding + BGE-M3 download) |
