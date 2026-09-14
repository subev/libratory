import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appRouter } from "../router.ts";
import { computeBookStatus } from "../routes/books.ts";
import { db } from "../db.ts";
import { books, chapters, OCR_ENGINES, type Chapter } from "../schema.ts";
import { and, desc, eq, sql } from "drizzle-orm";
import { createPdfBook, ensurePdfDir, newPdfBookId, pdfFileName, MAX_LANGUAGE_CHARS } from "./pdf-books.ts";
import { modelKeySchema } from "./llm.ts";
import path from "node:path";
import { copyFile, rm, stat } from "node:fs/promises";

// The agent-facing surface: a curated dozen over the tRPC router, not the router itself. Every
// long job returns at once with the book's state; wait_for_book is how a caller blocks on it.
// Each tool call gets its own server (the transport is stateless), so this must stay cheap.
export function createMcpServer(profileId: string): McpServer {
  const caller = appRouter.createCaller({ profileId });
  const server = new McpServer({ name: "libratory", version: "1" });

  const json = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  });

  const bookId = z.string().uuid().describe("Book id");
  const chapterId = z.string().uuid().describe("Chapter id");

  const getBook = async (id: string) => {
    const [book, assemblies, documents] = await Promise.all([
      caller.books.get({ id }),
      caller.books.assemblies({ bookId: id }),
      caller.books.documents({ bookId: id }),
    ]);
    return compactBook(book, assemblies, documents);
  };

  server.registerTool(
    "list_books",
    {
      description: "List the books in the library, newest first, with their processing status and chapter counts.",
      inputSchema: { folderId: z.string().uuid().nullable().optional().describe("Only books in this folder; omit for all") },
    },
    async ({ folderId }) => {
      const rows = await db
        .select()
        .from(books)
        .where(folderId ? and(eq(books.profileId, profileId), eq(books.folderId, folderId)) : eq(books.profileId, profileId))
        .orderBy(desc(books.createdAt));
      const agg = (await db.execute(sql`
        SELECT book_id, status, count(*)::int AS count, count(*) FILTER (WHERE audio_path IS NOT NULL)::int AS with_audio
        FROM chapters GROUP BY book_id, status
      `)) as unknown as Array<{ book_id: string; status: string; count: number; with_audio: number }>;
      return json(
        rows.map((book) => {
          const mine = agg.filter((a) => a.book_id === book.id);
          const statuses = mine.flatMap((a) => Array.from({ length: a.count }, () => a.status as Chapter["status"]));
          return {
            id: book.id,
            title: book.title,
            author: book.author,
            kind: book.kind,
            status: computeBookStatus(book, statuses),
            error: book.error,
            chapters: statuses.length,
            chaptersWithAudio: mine.reduce((n, a) => n + a.with_audio, 0),
            outputReady: book.outputPath !== null,
            folderId: book.folderId,
            createdAt: book.createdAt,
          };
        }),
      );
    },
  );

  server.registerTool(
    "upload_book",
    {
      description:
        "Create a book from PDF files already on the machine running Libratory (absolute paths; the files are copied). " +
        "By default the whole pipeline runs unattended — text extraction, chapter detection, narration of every chapter, and assembly into one M4B — " +
        "so follow with wait_for_book until \"output\". Set fullExtract=false for an instant text-only book (readable and searchable in seconds, no chapters until extract_chapters), " +
        "or skipSynthesis=true to detect chapters but leave narration for synthesize_book.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(50).describe("Absolute paths to PDF files, in reading order; several files make one book"),
        title: z.string().trim().min(1).max(500).optional().describe("Defaults to the first file's name"),
        voice: z.string().optional().describe("Narrator voice id, e.g. kokoro:af_heart (default)"),
        speed: z.number().min(0.5).max(2).optional(),
        language: z.string().trim().max(MAX_LANGUAGE_CHARS).optional().describe("Language code of the text, e.g. en, bg; detected from the text when omitted"),
        folderId: z.string().uuid().optional(),
        fullExtract: z.boolean().default(true),
        skipSynthesis: z.boolean().default(false),
        llmChapterDetection: z.boolean().default(false).describe("Let an AI model read the table of contents to place chapters"),
        chapterModel: modelKeySchema.optional().describe("Model key for llmChapterDetection"),
        ocrEngine: z.enum(OCR_ENGINES).optional().describe("OCR engine for scanned pages; tesseract when omitted"),
      },
    },
    async (input) => {
      for (const p of input.paths) {
        if (!path.isAbsolute(p)) throw new Error(`Not an absolute path: ${p}`);
        if (!p.toLowerCase().endsWith(".pdf")) throw new Error(`Not a PDF: ${p}`);
        const info = await stat(p).catch(() => null);
        if (!info?.isFile()) throw new Error(`No such file: ${p}`);
      }
      const { bookId: id, pdfDir } = newPdfBookId();
      await ensurePdfDir(pdfDir);
      try {
        const files = [];
        for (const [index, p] of input.paths.entries()) {
          const pdfPath = path.join(pdfDir, pdfFileName(index));
          await copyFile(p, pdfPath);
          files.push({ index, filename: path.basename(p), pdfPath });
        }
        await createPdfBook(id, { ...input, files }, profileId);
      } catch (err) {
        await db.delete(books).where(eq(books.id, id)).catch(() => {});
        await rm(pdfDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return json(await getBook(id));
    },
  );

  server.registerTool(
    "get_book",
    {
      description: "A book's status, files, chapters (without text), assembled audiobooks and exported documents.",
      inputSchema: { id: bookId },
    },
    async ({ id }) => json(await getBook(id)),
  );

  server.registerTool(
    "wait_for_book",
    {
      description:
        "Block until a book reaches a stage, or the timeout passes, then return its state. Stages: \"text\" (raw text extracted), " +
        "\"chapters\" (chapter detection finished), \"audio\" (no chapter still narrating), \"output\" (the M4B is assembled). " +
        "Returns early when the book fails. Call again if it times out — the work keeps running. The default timeout fits under the usual 60 s client limit; raise it only if the client allows longer calls.",
      inputSchema: {
        id: bookId,
        until: z.enum(["text", "chapters", "audio", "output"]).default("output"),
        timeoutSeconds: z.number().int().min(1).max(600).default(50),
      },
    },
    async ({ id, until, timeoutSeconds }, extra) => {
      const started = Date.now();
      const deadline = started + timeoutSeconds * 1000;
      const progressToken = progressTokenOf(extra);
      for (;;) {
        const book = await getBook(id);
        const outcome = stageReached(book, until);
        const elapsedSeconds = Math.round((Date.now() - started) / 1000);
        if (outcome) return json({ ...outcome, elapsedSeconds, book });
        const remaining = deadline - Date.now();
        if (remaining <= 0 || extra.signal.aborted) return json({ satisfied: false, reason: "timeout", elapsedSeconds, book });
        // Clients that reset their timeout on progress can then wait the full timeoutSeconds.
        if (progressToken !== undefined) {
          await extra
            .sendNotification({ method: "notifications/progress", params: { progressToken, progress: elapsedSeconds, total: timeoutSeconds, message: book.status } })
            .catch(() => {});
        }
        await sleep(Math.min(POLL_MS, remaining), extra.signal);
      }
    },
  );

  server.registerTool(
    "get_book_logs",
    {
      description: "The book's processing log, oldest first — what extraction, narration and assembly reported.",
      inputSchema: { id: bookId, after: z.string().datetime().optional().describe("Only entries after this ISO timestamp") },
    },
    async ({ id, after }) => json(await caller.books.logs({ bookId: id, after })),
  );

  server.registerTool(
    "get_chapter",
    {
      description: "A chapter with the text the narrator reads (edited text, else cleaned, else raw). Long chapters page through offset/maxChars.",
      inputSchema: {
        id: chapterId,
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1).max(200_000).default(20_000),
      },
    },
    async ({ id, offset, maxChars }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id));
      if (!chapter) throw new Error("Chapter not found");
      const textSource = chapter.customText ? "custom" : chapter.cleanText ? "clean" : "raw";
      const text = chapter.customText ?? chapter.cleanText ?? chapter.rawText;
      return json({
        id: chapter.id,
        bookId: chapter.bookId,
        index: chapter.index,
        title: chapter.title,
        status: chapter.status,
        selected: chapter.selected,
        pageStart: chapter.pageStart,
        pageEnd: chapter.pageEnd,
        durationMs: chapter.durationMs,
        hasAudio: chapter.audioPath !== null,
        error: chapter.error,
        textSource,
        totalChars: text.length,
        offset,
        truncated: offset + maxChars < text.length,
        text: text.slice(offset, offset + maxChars),
      });
    },
  );

  server.registerTool(
    "set_chapter_text",
    {
      description: "Replace what the narrator reads for a chapter. The extracted text is kept; re-run synthesize_chapter for new audio.",
      inputSchema: { id: chapterId, text: z.string().min(1) },
    },
    async ({ id, text }) => json(await caller.chapters.updateText({ id, customText: text })),
  );

  server.registerTool(
    "extract_chapters",
    {
      description: "Run the full extraction on a text-only book (uploaded with fullExtract=false): reads the pages thoroughly and detects chapters. Slow; then wait_for_book until \"chapters\".",
      inputSchema: { id: bookId },
    },
    async ({ id }) => {
      await caller.books.extractChapters({ id });
      return json(await getBook(id));
    },
  );

  server.registerTool(
    "redetect_chapters",
    {
      description: "Detect the chapters again from the extracted pages, optionally with an AI model reading the table of contents. Existing chapters and their audio are replaced.",
      inputSchema: {
        id: bookId,
        llmChapterDetection: z.boolean().optional(),
        chapterModel: modelKeySchema.optional(),
        ocrEngine: z.enum(OCR_ENGINES).nullable().optional(),
      },
    },
    async (input) => {
      await caller.books.redetectChapters(input);
      return json(await getBook(input.id));
    },
  );

  server.registerTool(
    "synthesize_book",
    {
      description: "Narrate every selected chapter with the book's voice (re-narrating ones that already have audio). Then wait_for_book until \"audio\", or assemble_book with waitForAll.",
      inputSchema: { id: bookId },
    },
    async ({ id }) => {
      await caller.books.processSelected({ id });
      return json(await getBook(id));
    },
  );

  server.registerTool(
    "synthesize_chapter",
    {
      description: "Narrate one chapter (again).",
      inputSchema: { id: chapterId },
    },
    async ({ id }) => json(await caller.chapters.queue({ id })),
  );

  server.registerTool(
    "assemble_book",
    {
      description: "Assemble the narrated chapters into one M4B with chapter markers. With waitForAll (default) it waits for chapters still narrating. Then wait_for_book until \"output\".",
      inputSchema: { id: bookId, waitForAll: z.boolean().default(true) },
    },
    async ({ id, waitForAll }) => {
      await caller.books.assemble({ id, waitForAll });
      return json(await getBook(id));
    },
  );

  server.registerTool(
    "export_book",
    {
      description: "Export the selected chapters as a document: pdf, epub, or epub-sync (text plus narration, read-along). The result appears under documents in get_book.",
      inputSchema: {
        id: bookId,
        format: z.enum(["pdf", "epub", "epub-sync"]),
        language: z.string().min(1).optional().describe("Export a translation instead of the original"),
        waitForAll: z.boolean().default(true),
      },
    },
    async (input) => {
      await caller.books.exportDocument(input);
      return json(await getBook(input.id));
    },
  );

  server.registerTool(
    "cancel_book",
    {
      description: "Stop a book's extraction and narration and clear its queued jobs. Chapters keep whatever audio they already have.",
      inputSchema: { id: bookId },
    },
    async ({ id }) => json(await caller.books.cancel({ id })),
  );

  server.registerTool(
    "search_library",
    {
      description: "Search the text of every book in the library. Results cite the book, chapter and page.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        folderId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(30).optional(),
        mode: z.enum(["hybrid", "keyword"]).optional().describe("hybrid (default) adds semantic matches when the index is built"),
      },
    },
    async (input) => json(await caller.search.library(input)),
  );

  return server;
}

const POLL_MS = 2000;

// The SDK hands the client's progress token over as `_meta`, a name the lint rules reject inline.
function progressTokenOf(extra: { [key: string]: unknown }): string | number | undefined {
  const meta = extra["_meta"] as { progressToken?: string | number } | undefined;
  return meta?.progressToken;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

type Caller = ReturnType<typeof appRouter.createCaller>;
type BookDetail = Awaited<ReturnType<Caller["books"]["get"]>>;
type CompactBook = ReturnType<typeof compactBook>;

function compactBook(
  book: BookDetail,
  assemblies: Awaited<ReturnType<Caller["books"]["assemblies"]>>,
  documents: Awaited<ReturnType<Caller["books"]["documents"]>>,
) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    kind: book.kind,
    status: book.status,
    error: book.error,
    voice: book.voice,
    speed: book.speed,
    language: book.language,
    folderId: book.folderId,
    totalWords: book.totalWords,
    totalDurationMs: book.totalDurationMs,
    outputPath: book.outputPath,
    downloadUrl: book.outputPath ? `/download/${book.id}` : null,
    assembleQueued: book.assembleQueued,
    files: book.files.map((f) => ({
      index: f.index,
      filename: f.filename,
      status: f.status,
      hasRawText: f.hasRawText,
      rawWords: f.rawWords,
      error: f.error,
    })),
    chapters: book.chapters.map((c) => ({
      id: c.id,
      index: c.index,
      title: c.title,
      status: c.status,
      selected: c.selected,
      wordCount: c.wordCount,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      durationMs: c.durationMs,
      hasAudio: c.audioPath !== null,
      error: c.error,
    })),
    assemblies: assemblies.map((a) => ({ id: a.id, outputPath: a.outputPath, sizeBytes: a.sizeBytes, createdAt: a.createdAt, downloadUrl: `/download/assembly/${a.id}` })),
    documents: documents.map((d) => ({ id: d.id, format: d.format, language: d.language, outputPath: d.outputPath, sizeBytes: d.sizeBytes, createdAt: d.createdAt, downloadUrl: `/download/document/${d.id}` })),
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

const AUDIO_IN_FLIGHT = new Set(["pending", "normalizing", "synthesizing"]);
const EXTRACTION_IN_FLIGHT = new Set(["pending", "extracting"]);

function audioSettled(book: CompactBook): boolean {
  return !book.chapters.some((c) => c.selected && AUDIO_IN_FLIGHT.has(c.status));
}

export function stageReached(book: CompactBook, until: "text" | "chapters" | "audio" | "output"): { satisfied: boolean; reason?: string } | null {
  if (book.status === "failed") return { satisfied: false, reason: book.error ?? "failed" };
  const extracting = book.status === "extracting" || book.files.some((f) => EXTRACTION_IN_FLIGHT.has(f.status));
  switch (until) {
    case "text":
      return book.files.some((f) => f.hasRawText) ? { satisfied: true } : null;
    case "chapters":
      return book.chapters.length > 0 && !extracting ? { satisfied: true } : null;
    case "audio":
      return book.chapters.length > 0 && !extracting && audioSettled(book) ? { satisfied: true } : null;
    case "output":
      // processSelected re-narrates without clearing outputPath, so the old M4B alone is not the answer
      return book.outputPath !== null && book.status !== "assembling" && !book.assembleQueued && audioSettled(book)
        ? { satisfied: true }
        : null;
  }
}
