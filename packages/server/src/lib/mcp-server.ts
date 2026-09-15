import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appRouter } from "../router.ts";
import { computeBookStatus } from "../routes/books.ts";
import { db } from "../db.ts";
import { bookFiles, bookLogs, books, chapters, OCR_ENGINES, DEFAULT_OCR_ENGINE, type Chapter } from "../schema.ts";
import { and, desc, eq, sql } from "drizzle-orm";
import { createPdfBook, ensurePdfDir, newPdfBookId, pdfFileName, MAX_LANGUAGE_CHARS } from "./pdf-books.ts";
import { modelKeySchema } from "./llm.ts";
import { listAllVoices } from "./voice-list.ts";
import { bundleInstalled, listModelBundles, readCapabilities, startBundleDownload } from "./model-bundles.ts";
import { SURYA_BUNDLE } from "./ocr-surya.ts";
import { listOcrLanguages, packCodeSchema, startPackDownload } from "./tessdata.ts";
import { listPocketLanguages } from "./pocket-languages.ts";
import { LLM_SECRETS, isConfigured, secretStatus } from "./secrets.ts";
import { detectLanguage } from "./detect-language.ts";
import { countWords, extractPdfAuthor, extractPdfRawText, pdfHasTextLayer } from "./pdf-raw-text.ts";
import { pdfPageCount } from "./ocr-tesseract.ts";
import path from "node:path";
import { copyFile, rm, stat } from "node:fs/promises";

// The agent-facing surface: about twenty curated tools over the tRPC router, not the router
// itself. Every long job returns at once with the book's state; wait_for_book is how a caller
// blocks on it. Each request gets its own server (the transport is stateless), so this must stay cheap.
export function createMcpServer(profileId: string): McpServer {
  const caller = appRouter.createCaller({ profileId });
  const server = new McpServer({ name: "libratory", version: "1" });

  const json = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  });

  const bookId = z.string().uuid().describe("Book id");
  const chapterId = z.string().uuid().describe("Chapter id");

  const getBook = async (id: string) => {
    const [book, assemblies, documents, [latestLog]] = await Promise.all([
      caller.books.get({ id }),
      caller.books.assemblies({ bookId: id }),
      caller.books.documents({ bookId: id }),
      db
        .select({ message: bookLogs.message, createdAt: bookLogs.createdAt })
        .from(bookLogs)
        .where(eq(bookLogs.bookId, id))
        .orderBy(desc(bookLogs.createdAt))
        .limit(1),
    ]);
    return compactBook(book, assemblies, documents, latestLog ?? null);
  };

  // The UI hides full extraction until the models are on disk; MCP has no such gate, and without
  // this the Python step fails offline with an error that names nothing the caller can do.
  const requireExtractionModels = async () => {
    if (await bundleInstalled(SURYA_BUNDLE)) return;
    throw new Error(
      `Full extraction needs the "${SURYA_BUNDLE}" model bundle, which is not installed — call start_download { kind: "bundle", id: "${SURYA_BUNDLE}" } and watch get_capabilities until installed`,
    );
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
    "inspect_pdf",
    {
      description:
        "Look at a PDF on the machine running Libratory before uploading it: page count, whether it has a text layer or is a scan needing OCR, " +
        "a language guess from the text, word count and author. Use it to choose language, voice and OCR engine up front.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to the PDF") },
    },
    async ({ path: pdfPath }) => {
      await requirePdfPath(pdfPath);
      const [pages, hasTextLayer, text, author, info] = await Promise.all([
        pdfPageCount(pdfPath).catch(() => null),
        pdfHasTextLayer(pdfPath),
        extractPdfRawText(pdfPath),
        extractPdfAuthor(pdfPath),
        stat(pdfPath),
      ]);
      const words = text ? countWords(text) : 0;
      return json({
        path: pdfPath,
        sizeBytes: info.size,
        pages,
        hasTextLayer,
        scanned: hasTextLayer === false,
        words,
        language: text ? detectLanguage(text.slice(0, 20_000)) : null,
        author,
        sample: text ? text.replace(/\s+/g, " ").trim().slice(0, 300) : null,
      });
    },
  );

  server.registerTool(
    "upload_book",
    {
      description:
        "Create a book from PDF files already on the machine running Libratory (absolute paths; the files are copied). " +
        "By default the whole pipeline runs unattended — text extraction, chapter detection, narration of every chapter, and assembly into one M4B — " +
        "so follow with wait_for_book until \"output\". Set fullExtract=false for an instant text-only book (readable and searchable in seconds, no chapters until extract_book), " +
        "or skipSynthesis=true to detect chapters but leave narration for synthesize_book. Scanned pages are read by OCR in the book's language, " +
        "which needs that language's pack (see get_capabilities); pick voices with list_voices.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(50).describe("Absolute paths to PDF files, in reading order; several files make one book"),
        title: z.string().trim().min(1).max(500).optional().describe("Defaults to the first file's name"),
        voice: z.string().optional().describe("Narrator voice id from list_voices, e.g. kokoro:af_heart (default)"),
        speed: z.number().min(0.5).max(2).optional(),
        language: z.string().trim().max(MAX_LANGUAGE_CHARS).optional().describe("Language code of the text, e.g. en, bg; detected from the text when omitted"),
        folderId: z.string().uuid().optional(),
        fullExtract: z.boolean().default(true),
        skipSynthesis: z.boolean().default(false),
        llmChapterDetection: z.boolean().default(false).describe("Let an AI model read the table of contents to place and title chapters"),
        chapterModel: modelKeySchema.optional().describe("Model key for llmChapterDetection"),
        ocrEngine: z.enum(OCR_ENGINES).optional().describe(`OCR engine for scanned pages; ${DEFAULT_OCR_ENGINE} when omitted, surya reads photographed or faded pages better, llm sends page images to a cloud vision model (needs an AI provider key; see get_capabilities)`),
        ocrModel: modelKeySchema.optional().describe("Vision model key for ocrEngine llm; the default model when omitted"),
      },
    },
    async (input) => {
      for (const p of input.paths) await requirePdfPath(p);
      if (input.fullExtract) await requireExtractionModels();
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
      description: "A book's status, latest log line, files, chapters (without text, with narration progress), assembled audiobooks and exported documents.",
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
            .sendNotification({ method: "notifications/progress", params: { progressToken, progress: elapsedSeconds, total: timeoutSeconds, message: book.latestLog?.message ?? book.status } })
            .catch(() => {});
        }
        await sleep(Math.min(POLL_MS, remaining), extra.signal);
      }
    },
  );

  server.registerTool(
    "get_book_logs",
    {
      description: "The book's processing log, oldest first — what extraction, OCR, narration and assembly reported, including page and chunk progress.",
      inputSchema: { id: bookId, after: z.string().datetime().optional().describe("Only entries after this ISO timestamp") },
    },
    async ({ id, after }) => json(await caller.books.logs({ bookId: id, after })),
  );

  server.registerTool(
    "get_book_text",
    {
      description: "The raw text of one of the book's PDF files as extracted or OCR'd, before and independent of chapters — for checking OCR quality before narrating. Pages through offset/maxChars.",
      inputSchema: {
        id: bookId,
        fileIndex: z.number().int().min(0).default(0),
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1).max(200_000).default(20_000),
      },
    },
    async ({ id, fileIndex, offset, maxChars }) => {
      const [file] = await db.select().from(bookFiles).where(and(eq(bookFiles.bookId, id), eq(bookFiles.index, fileIndex)));
      if (!file) throw new Error("File not found");
      const text = file.rawText ?? "";
      return json({
        bookId: id,
        fileIndex,
        filename: file.filename,
        status: file.status,
        ocrEngine: file.ocrEngine,
        hasRawText: file.rawText !== null,
        ...page(text, offset, maxChars),
      });
    },
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
        ...page(text, offset, maxChars),
      });
    },
  );

  server.registerTool(
    "update_chapter",
    {
      description: "Change a chapter's title, the text the narrator reads (the extracted text is kept), or whether it is selected for narration, assembly and export. Re-run synthesize_book for new audio after a text change.",
      inputSchema: {
        id: chapterId,
        title: z.string().trim().min(1).optional(),
        text: z.string().min(1).optional(),
        selected: z.boolean().optional(),
      },
    },
    async ({ id, title, text, selected }) => {
      if (title === undefined && text === undefined && selected === undefined) throw new Error("Nothing to change");
      if (title !== undefined) await caller.chapters.rename({ id, title });
      if (text !== undefined) await caller.chapters.updateText({ id, customText: text });
      if (selected !== undefined) await caller.chapters.setSelected({ id, selected });
      return json({ success: true });
    },
  );

  server.registerTool(
    "extract_book",
    {
      description:
        "Run or redo the full extraction: OCR of scanned pages (in the book's language), a thorough page read and chapter detection. " +
        "Pass ocrEngine to read the pages again with another engine (tesseract, surya, or llm for a cloud vision model). Existing chapters and audio are replaced, and after a redo the new chapters wait suspended for synthesize_book. Slow; then wait_for_book until \"chapters\".",
      inputSchema: { id: bookId, ocrEngine: z.enum(OCR_ENGINES).optional(), ocrModel: modelKeySchema.optional() },
    },
    async ({ id, ocrEngine, ocrModel }) => {
      await requireExtractionModels();
      if (ocrEngine !== undefined || ocrModel !== undefined) await caller.books.updateSettings({ id, ocrEngine, ocrModel });
      const files = await db.select({ status: bookFiles.status }).from(bookFiles).where(eq(bookFiles.bookId, id));
      if (files.length > 0 && files.every((f) => f.status === "raw")) await caller.books.extractChapters({ id });
      else await caller.bookFiles.reExtractSelected({ bookId: id });
      return json(await getBook(id));
    },
  );

  server.registerTool(
    "redetect_chapters",
    {
      description:
        "Detect the chapters again from the pages already extracted, optionally with an AI model reading the table of contents for real titles. " +
        "Existing chapters and their audio are replaced. This does not read the pages again — use extract_book to change the OCR engine.",
      inputSchema: {
        id: bookId,
        llmChapterDetection: z.boolean().optional(),
        chapterModel: modelKeySchema.optional(),
      },
    },
    async (input) => {
      await caller.books.redetectChapters(input);
      return json(await getBook(input.id));
    },
  );

  server.registerTool(
    "cleanup_chapters",
    {
      description: "Have an AI model repair OCR artifacts in chapter text — split or joined words, stray hyphens, headers and page numbers — into an edited copy the narrator reads. Runs in the background; each chapter's cleanup status is in get_book.",
      inputSchema: { bookId, chapterIds: z.array(chapterId).min(1).optional().describe("Only these chapters; omit for every selected chapter") },
    },
    async ({ bookId: id, chapterIds }) => {
      if (chapterIds) for (const chapter of chapterIds) await caller.chapters.queueCleanup({ id: chapter });
      else await caller.chapters.cleanupSelected({ bookId: id });
      return json({ queued: chapterIds?.length ?? "selected" });
    },
  );

  server.registerTool(
    "synthesize_book",
    {
      description:
        "Narrate every selected chapter with the book's voice, re-narrating ones that already have audio; or only chapterIds, where resume=true continues an interrupted chapter from its finished chunks. " +
        "Then wait_for_book until \"audio\", or assemble_book with waitForAll.",
      inputSchema: { id: bookId, chapterIds: z.array(chapterId).min(1).optional(), resume: z.boolean().default(false) },
    },
    async ({ id, chapterIds, resume }) => {
      if (chapterIds) for (const chapter of chapterIds) await caller.chapters.queue({ id: chapter, resume });
      else await caller.books.processSelected({ id });
      return json(await getBook(id));
    },
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
    "set_book_settings",
    {
      description: "Change a book after upload: narrator voice (from list_voices), speed, the language of its text, author, OCR engine, or AI chapter detection. Audio already narrated keeps the old voice until synthesize_book runs again.",
      inputSchema: {
        id: bookId,
        voice: z.string().optional(),
        speed: z.number().min(0.5).max(2).optional(),
        language: z.string().max(MAX_LANGUAGE_CHARS).nullable().optional().describe("ISO code; null clears it"),
        author: z.string().max(200).nullable().optional(),
        ocrEngine: z.enum(OCR_ENGINES).nullable().optional(),
        ocrModel: modelKeySchema.nullable().optional().describe("Vision model for the llm OCR engine; null = default"),
        llmChapterDetection: z.boolean().optional(),
        chapterModel: modelKeySchema.optional(),
      },
    },
    async (input) => {
      await caller.books.updateSettings(input);
      return json(await getBook(input.id));
    },
  );

  server.registerTool(
    "list_voices",
    {
      description:
        "Every narrator voice this installation can use, with the language each reads: local engines (Kokoro, Pocket TTS, the Bulgarian and multilingual MLX narrators, installed macOS voices) " +
        "and cloud ones behind a configured key (Cartesia, ElevenLabs — metered). Filter by language code to find a voice for a book.",
      inputSchema: {
        language: z.string().trim().min(2).max(8).optional().describe("ISO code, e.g. en, bg"),
        engine: z.enum(["kokoro", "narrators", "say", "cartesia", "elevenlabs", "pocket"]).optional(),
      },
    },
    async (filter) => json(await listAllVoices(filter)),
  );

  server.registerTool(
    "get_capabilities",
    {
      description:
        "What this installation can do right now: hardware (MLX/CUDA), model bundles and whether each is installed or downloading, OCR engines and the language packs installed or downloading " +
        "(any other language is fetched by ISO code with start_download), Pocket TTS languages, and which cloud keys are configured. Check before full extraction, OCR in a new language, or a cloud voice.",
      inputSchema: {},
    },
    async () => {
      const [hardware, bundles, ocrLanguages, pocketLanguages, secrets] = await Promise.all([
        readCapabilities().catch(() => null),
        listModelBundles().catch(() => []),
        listOcrLanguages(),
        listPocketLanguages().catch(() => []),
        Promise.resolve(secretStatus()),
      ]);
      return json({
        hardware,
        bundles: bundles.map((b) => ({ id: b.id, label: b.label, unlocks: b.unlocks, approxMb: b.approxMb, appleSiliconOnly: b.appleSiliconOnly, installed: b.installed, downloading: b.downloading, progress: b.progress, error: b.error })),
        // llm is the cloud engine: page images go to a vision model, so it needs a provider key rather than a bundle
        ocrEngines: OCR_ENGINES.map((id) => ({ id, default: id === DEFAULT_OCR_ENGINE, needsBundle: id === "surya" ? SURYA_BUNDLE : null, cloud: id === "llm", available: id !== "llm" || LLM_SECRETS.some((s) => isConfigured(s.envVar)) })),
        ocrLanguages: ocrLanguages
          .filter((l) => l.installed || l.download !== null)
          .map((l) => ({ code: l.code, iso: l.iso, name: l.name, approxMb: Math.round(l.bytes / 1_000_000), installed: l.installed, downloading: l.download !== null && l.download.error === null, error: l.download?.error ?? null })),
        ocrLanguagesAvailable: ocrLanguages.length,
        pocketLanguages: pocketLanguages.map((l) => ({ code: l.code, label: l.label, approxMb: l.approxMb, installed: l.installed, downloading: l.downloading, error: l.error })),
        cloudKeys: secrets.keys.map((k) => ({ envVar: k.envVar, label: k.label, kind: k.kind, configured: k.configured })),
      });
    },
  );

  server.registerTool(
    "start_download",
    {
      description: "Download a missing model bundle, Tesseract OCR language pack, or Pocket TTS language. Returns at once; watch get_capabilities for installed/downloading/error.",
      inputSchema: {
        kind: z.enum(["bundle", "ocrLanguage", "pocketLanguage"]),
        id: z.string().min(1).max(40).describe("Bundle id, Tesseract pack code or ISO language code (bul or bg), or Pocket language code from get_capabilities"),
      },
    },
    async ({ kind, id }) => {
      switch (kind) {
        case "bundle":
          return json(startBundleDownload(id));
        case "ocrLanguage": {
          const byIso = (await listOcrLanguages()).find((l) => l.iso === id.toLowerCase())?.code;
          const code = packCodeSchema.safeParse(byIso ?? id);
          if (!code.success) throw new Error(`No Tesseract language pack for "${id}" — pass a pack code or ISO code such as bul or bg`);
          return json(startPackDownload(code.data));
        }
        case "pocketLanguage":
          return json(await caller.pocketVoices.downloadLanguage({ code: id }));
      }
    },
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

function page(text: string, offset: number, maxChars: number) {
  return { totalChars: text.length, offset, truncated: offset + maxChars < text.length, text: text.slice(offset, offset + maxChars) };
}

async function requirePdfPath(p: string): Promise<void> {
  if (!path.isAbsolute(p)) throw new Error(`Not an absolute path: ${p}`);
  if (!p.toLowerCase().endsWith(".pdf")) throw new Error(`Not a PDF: ${p}`);
  const info = await stat(p).catch(() => null);
  if (!info?.isFile()) throw new Error(`No such file: ${p}`);
}

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
  latestLog: { message: string; createdAt: Date } | null,
) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    kind: book.kind,
    status: book.status,
    error: book.error,
    latestLog,
    voice: book.voice,
    speed: book.speed,
    language: book.language,
    ocrEngine: book.ocrEngine,
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
      ocrEngine: f.ocrEngine,
      error: f.error,
    })),
    chapters: book.chapters.map((c) => ({
      id: c.id,
      index: c.index,
      title: c.title,
      status: c.status,
      progress: c.progress,
      selected: c.selected,
      wordCount: c.wordCount,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      durationMs: c.durationMs,
      hasAudio: c.audioPath !== null,
      cleanup: c.cleanup?.status ?? null,
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
