import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appRouter } from "../router.ts";
import { computeBookStatus } from "../routes/books.ts";
import { db } from "../db.ts";
import { bookFiles, bookLogs, books, chapters, folders, notes, OCR_ENGINES, DEFAULT_OCR_ENGINE, type Chapter } from "../schema.ts";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
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
import { appendApiChapters, chapterInputSchema, createApiBook } from "./api-books.ts";
import { listFolderPaths, listProfiles, resolveFolderId, resolveProfileId } from "./mcp-library.ts";
import { saveNote } from "./notes.ts";
import { parseTtsVoice } from "./tts.ts";
import { consumeStaged, isStagedRef, resolveStaged } from "./staged-files.ts";
import path from "node:path";
import { copyFile, rm, stat } from "node:fs/promises";

// The agent-facing surface: about twenty curated tools over the tRPC router, not the router
// itself. Every long job returns at once with a summary of the book; wait_for_book is how a caller
// blocks on it. Each request gets its own server (the transport is stateless), so this must stay cheap.
// Only get_book answers with every chapter: an agent pays for each token of a result and polls in
// loops, and a 300-chapter book repeated on every call was most of a session's context.
export function createMcpServer(profileId: string): McpServer {
  const caller = appRouter.createCaller({ profileId });
  const server = new McpServer({ name: "libratory", version: "1" });

  const json = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  });

  const bookId = z.string().uuid().describe("Book id");
  const chapterId = z.string().uuid().describe("Chapter id");
  const profileArg = z.string().trim().min(1).max(200).optional().describe("Profile name or id from list_books; the connection's profile when omitted");

  // The x-profile-id header is fixed when the client is configured, so without a per-call
  // override an agent could never reach a second profile.
  const scoped = async (profile: string | undefined) => {
    const id = profile === undefined ? profileId : await resolveProfileId(profile);
    return { profileId: id, caller: id === profileId ? caller : appRouter.createCaller({ profileId: id }) };
  };

  const getBook = (id: string) => loadBook(caller, id);
  const getSummary = async (id: string) => summarizeBook(await getBook(id));

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
      description:
        "The library's layout and its books: the profiles (separate workspaces) with the current one marked, this profile's folders as paths with book counts, " +
        "and the books newest first with processing status and chapter counts. Start here to find a book id, or a profile or folder to put a new book in. " +
        "A large library is cut at `limit` — narrow it with `query` (words from the title) or `folder`.",
      inputSchema: {
        profile: profileArg,
        folder: z.string().trim().min(1).optional().describe("Only books directly in this folder: a path such as Work/Contracts, or a folder id"),
        query: z.string().trim().min(1).max(200).optional().describe("Only books whose title contains this"),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ profile, folder, query, limit }) => {
      const scope = await scoped(profile);
      const folderId = folder === undefined ? null : await resolveFolderId(scope.profileId, folder, { create: false });
      const where = and(
        eq(books.profileId, scope.profileId),
        folderId ? eq(books.folderId, folderId) : undefined,
        query ? ilike(books.title, `%${query.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
      );
      const [[total], rows, profileList, folderList] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(books).where(where),
        db.select().from(books).where(where).orderBy(desc(books.createdAt)).limit(limit),
        listProfiles(scope.profileId),
        listFolderPaths(scope.profileId),
      ]);
      const ids = rows.map((r) => r.id);
      const agg = ids.length === 0 ? [] : await db
        .select({
          bookId: chapters.bookId,
          status: chapters.status,
          count: sql<number>`count(*)::int`,
          withAudio: sql<number>`(count(*) FILTER (WHERE ${chapters.audioPath} IS NOT NULL))::int`,
        })
        .from(chapters)
        .where(inArray(chapters.bookId, ids))
        .groupBy(chapters.bookId, chapters.status);
      return json({
        profiles: profileList,
        folders: folderList.map((f) => ({ id: f.id, path: f.path, books: f.books })),
        totalBooks: total?.count ?? rows.length,
        truncated: (total?.count ?? rows.length) > rows.length,
        books: rows.map((book) => {
          const mine = agg.filter((a) => a.bookId === book.id);
          const statuses = mine.flatMap((a) => Array.from({ length: a.count }, (): Chapter["status"] => a.status));
          return {
            id: book.id,
            title: book.title,
            author: book.author,
            kind: book.kind,
            status: computeBookStatus(book, statuses),
            error: book.error,
            chapters: statuses.length,
            chaptersWithAudio: mine.reduce((n, a) => n + a.withAudio, 0),
            outputReady: book.outputPath !== null,
            folder: folderList.find((f) => f.id === book.folderId)?.path ?? null,
            createdAt: book.createdAt,
          };
        }),
      });
    },
  );

  server.registerTool(
    "inspect_pdf",
    {
      description:
        "Look at a PDF on the machine running Libratory before uploading it: page count, whether it has a text layer or is a scan needing OCR, " +
        "a language guess from the text, word count and author. Use it to choose language, voice and OCR engine up front.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to the PDF, or a staged:<id> reference to a file dropped on the assistant panel") },
    },
    async ({ path: source }) => {
      const { path: pdfPath } = await resolvePdfSource(source, profileId);
      const [pages, hasTextLayer, text, author, info] = await Promise.all([
        pdfPageCount(pdfPath).catch(() => null),
        pdfHasTextLayer(pdfPath),
        extractPdfRawText(pdfPath),
        extractPdfAuthor(pdfPath),
        stat(pdfPath),
      ]);
      const words = text ? countWords(text) : 0;
      return json({
        path: source,
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
        "By default the text is read and the chapters detected, and the chapters then wait for synthesize_book — narration is a decision taken after the chapters have been looked at, " +
        "so follow with wait_for_book until \"chapters\". Set fullExtract=false for an instant text-only book (readable and searchable in seconds, no chapters until extract_book), " +
        "or skipSynthesis=false to run the whole pipeline unattended — narration of every chapter and assembly into one M4B, wait_for_book until \"output\". Scanned pages are read by OCR in the book's language, " +
        "which needs that language's pack (see get_capabilities); pick voices with list_voices. Only PDFs — for text you already hold (a web page, markdown, a .docx you converted) use create_book. " +
        "Returns a summary; get_book lists the files and chapters.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).max(50).describe("PDF files in reading order — absolute paths, or staged:<id> references to files dropped on the assistant panel; several files make one book"),
        title: z.string().trim().min(1).max(500).optional().describe("Defaults to the first file's name"),
        voice: z.string().optional().describe("Narrator voice id from list_voices, e.g. kokoro:af_heart (default)"),
        speed: z.number().min(0.5).max(2).optional(),
        language: z.string().trim().max(MAX_LANGUAGE_CHARS).optional().describe("Language code of the text, e.g. en, bg; detected from the text when omitted"),
        profile: profileArg,
        folder: z.string().trim().min(1).optional().describe("Where to file it: a path such as Work/Contracts (created when missing) or a folder id; the top level when omitted"),
        fullExtract: z.boolean().default(true),
        skipSynthesis: z.boolean().default(true).describe("false narrates every chapter as soon as it is detected and assembles the M4B, unattended"),
        llmChapterDetection: z.boolean().default(false).describe("Let an AI model read the table of contents to place and title chapters"),
        chapterModel: modelKeySchema.optional().describe("Model key for llmChapterDetection"),
        ocrEngine: z.enum(OCR_ENGINES).optional().describe(`OCR engine for scanned pages; ${DEFAULT_OCR_ENGINE} when omitted, surya reads photographed or faded pages better, llm sends page images to a cloud vision model (needs an AI provider key; see get_capabilities)`),
        ocrModel: modelKeySchema.optional().describe("Vision model key for ocrEngine llm; the default model when omitted"),
      },
    },
    async (input) => {
      const sources = await Promise.all(input.paths.map((p) => resolvePdfSource(p, profileId)));
      if (input.fullExtract) await requireExtractionModels();
      // Before the folder: a refused voice must not leave an empty folder behind.
      if (input.voice !== undefined) parseTtsVoice(input.voice);
      const scope = await scoped(input.profile);
      const folderId = input.folder === undefined ? null : await resolveFolderId(scope.profileId, input.folder, { create: true });
      const { bookId: id, pdfDir } = newPdfBookId();
      await ensurePdfDir(pdfDir);
      try {
        const files = await Promise.all(sources.map(async (source, index) => {
          const pdfPath = path.join(pdfDir, pdfFileName(index));
          await copyFile(source.path, pdfPath);
          return { index, filename: source.filename, pdfPath };
        }));
        await createPdfBook(id, { ...input, folderId, files }, scope.profileId);
        // The book has its own copy now; the staged ones are done with
        await consumeStaged(input.paths);
      } catch (err) {
        await db.delete(books).where(eq(books.id, id)).catch(() => {});
        await rm(pdfDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return json(await getSummary(id));
    },
  );

  server.registerTool(
    "create_book",
    {
      description:
        "Create a book from text you already hold — an article, a web page, notes, a report you wrote — one chapter per entry, with no PDF involved. " +
        "The text is searchable at once (search_library) and can be narrated: synthesize=true starts narration now, otherwise the chapters wait for synthesize_book. " +
        "Write plain prose as it should be read aloud; markdown syntax is stripped. Pass appendTo to add chapters to an existing book instead of creating one. " +
        "A chapter's url is kept as its source link through to exports.",
      inputSchema: {
        title: z.string().trim().min(1).max(500).optional().describe("The new book's title; required unless appendTo is set"),
        appendTo: bookId.optional().describe("Append the chapters to this book instead"),
        chapters: z.array(chapterInputSchema).min(1).max(500),
        profile: profileArg,
        folder: z.string().trim().min(1).optional().describe("Where to file a new book: a path such as Work/Contracts (created when missing) or a folder id"),
        voice: z.string().optional().describe("Narrator voice id from list_voices"),
        speed: z.number().min(0.5).max(2).optional(),
        language: z.string().trim().max(MAX_LANGUAGE_CHARS).optional().describe("Language code of the text, e.g. en, bg; detected from the text when omitted"),
        synthesize: z.boolean().default(false),
        client: z.string().trim().min(1).max(100).optional().describe("Who is writing this, e.g. the agent's or script's name; shown as the book's origin"),
      },
    },
    async ({ title, appendTo, chapters: chapterInputs, profile, folder, voice, speed, language, synthesize, client }) => {
      if (appendTo !== undefined) {
        const appended = await appendApiChapters(appendTo, { chapters: chapterInputs, synthesize, client });
        if (!appended) throw new Error("Book not found");
        return json({ ...(await getSummary(appendTo)), added: appended.chapters });
      }
      if (title === undefined) throw new Error("A new book needs a title");
      if (voice !== undefined) parseTtsVoice(voice);
      const scope = await scoped(profile);
      const folderId = folder === undefined ? undefined : await resolveFolderId(scope.profileId, folder, { create: true });
      const created = await createApiBook({ title, folderId, client, voice, speed, language, chapters: chapterInputs, synthesize }, scope.profileId);
      return json({ ...(await getSummary(created.book.id)), added: created.chapters });
    },
  );

  server.registerTool(
    "get_book",
    {
      description:
        "Everything about one book: status, latest log line, files, every chapter with its id and narration progress (no text), assembled audiobooks, exported documents and saved notes. " +
        "This is the one call that lists chapters — the other tools answer with a summary. logs=true adds the processing log (OCR pages, narration chunks, failures; the newest 300 entries, logsOmitted counts the rest), logsAfter only the part of it after a timestamp.",
      inputSchema: {
        id: bookId,
        logs: z.boolean().default(false),
        logsAfter: z.string().datetime().optional().describe("Only log entries after this ISO timestamp; implies logs"),
      },
    },
    async ({ id, logs, logsAfter }) => {
      const book = await getBook(id);
      const noteRows = await db
        .select({ id: notes.id, title: notes.prompt, author: notes.model, chars: sql<number>`length(${notes.result})`, createdAt: notes.createdAt })
        .from(notes)
        .where(eq(notes.bookId, id))
        .orderBy(desc(notes.createdAt));
      if (!logs && logsAfter === undefined) return json({ ...book, notes: noteRows });
      // A narrated book logs every chunk; the end of the log is where the answer is.
      const entries = await caller.books.logs({ bookId: id, after: logsAfter });
      return json({ ...book, notes: noteRows, logsOmitted: Math.max(0, entries.length - MAX_LOG_ENTRIES), logs: entries.slice(-MAX_LOG_ENTRIES) });
    },
  );

  server.registerTool(
    "wait_for_book",
    {
      description:
        "Block until a book reaches a stage, or the timeout passes, then return a summary of it. Stages: \"text\" (every file has been read, OCR of scanned files included), " +
        "\"searchable\" (that text is indexed, so search_library sees all of it), \"chapters\" (chapter detection finished), \"audio\" (no chapter still narrating), \"output\" (the M4B is assembled). " +
        "Returns early when the book fails. Call again if it times out — the work keeps running. The default timeout fits under the usual 60 s client limit; raise it only if the client allows longer calls.",
      inputSchema: {
        id: bookId,
        until: z.enum(WAIT_STAGES).default("output"),
        timeoutSeconds: z.number().int().min(1).max(600).default(50),
      },
    },
    async ({ id, until, timeoutSeconds }, extra) => {
      const started = Date.now();
      const deadline = started + timeoutSeconds * 1000;
      const progressToken = progressTokenOf(extra);
      for (;;) {
        const book = await getBook(id);
        const outcome = stageReached(book, until, await queuedWork(id));
        const elapsedSeconds = Math.round((Date.now() - started) / 1000);
        if (outcome) return json({ ...outcome, elapsedSeconds, book: summarizeBook(book) });
        const remaining = deadline - Date.now();
        if (remaining <= 0 || extra.signal.aborted) return json({ satisfied: false, reason: "timeout", elapsedSeconds, book: summarizeBook(book) });
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
      const [before] = await db.select({ title: chapters.title, selected: chapters.selected }).from(chapters).where(eq(chapters.id, id));
      if (!before) throw new Error("Chapter not found");
      if (title !== undefined) await caller.chapters.rename({ id, title });
      if (text !== undefined) await caller.chapters.updateText({ id, customText: text });
      if (selected !== undefined) await caller.chapters.setSelected({ id, selected });
      const undo: Record<string, unknown> = { id };
      if (title !== undefined) undo.title = before.title;
      if (selected !== undefined) undo.selected = before.selected;
      return json({ success: true, ...(text === undefined && Object.keys(undo).length > 1 ? { undo: { tool: "update_chapter", input: undo } } : {}) });
    },
  );

  server.registerTool(
    "extract_book",
    {
      description:
        "Run or redo the full extraction: OCR of scanned pages (in the book's language), a thorough page read and chapter detection. " +
        "Pass ocrEngine to read the pages again with another engine (tesseract, surya, or llm for a cloud vision model). Existing chapters and audio are replaced; the new chapters wait suspended for synthesize_book, never narrated on their own. Slow; then wait_for_book until \"chapters\".",
      inputSchema: { id: bookId, ocrEngine: z.enum(OCR_ENGINES).optional(), ocrModel: modelKeySchema.optional() },
    },
    async ({ id, ocrEngine, ocrModel }) => {
      await requireExtractionModels();
      if (ocrEngine !== undefined || ocrModel !== undefined) await caller.books.updateSettings({ id, ocrEngine, ocrModel });
      // Extraction produces the structure; narration is decided afterwards, whatever the book was
      // uploaded with — a book made with the unattended default used to narrate all its chapters here
      await db.update(books).set({ skipSynthesis: true }).where(eq(books.id, id));
      const files = await db.select({ status: bookFiles.status }).from(bookFiles).where(eq(bookFiles.bookId, id));
      if (files.length > 0 && files.every((f) => f.status === "raw")) await caller.books.extractChapters({ id });
      else await caller.bookFiles.reExtractSelected({ bookId: id });
      return json(await getSummary(id));
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
      return json(await getSummary(input.id));
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
      return json(await getSummary(id));
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
      return json(await getSummary(id));
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
      return json(await getSummary(input.id));
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
      description: "Change a book after upload: title, the folder it is filed in, narrator voice (from list_voices), speed, the language of its text, author, OCR engine, or AI chapter detection. Audio already narrated keeps the old voice until synthesize_book runs again.",
      inputSchema: {
        id: bookId,
        title: z.string().trim().min(1).max(500).optional(),
        folder: z.string().trim().min(1).nullable().optional().describe("Move the book: a path such as Work/Contracts (created when missing) or a folder id; null moves it to the top level"),
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
    async ({ title, folder, ...settings }) => {
      const [before] = await db.select({ profileId: books.profileId, title: books.title, folderId: books.folderId, author: books.author }).from(books).where(eq(books.id, settings.id));
      if (!before) throw new Error("Book not found");
      if (title !== undefined) await caller.books.rename({ id: settings.id, title });
      if (folder !== undefined) {
        // A folder belongs to a profile, so the move runs as the book's own profile, not the connection's.
        const folderId = folder === null ? null : await resolveFolderId(before.profileId, folder, { create: true });
        await appRouter.createCaller({ profileId: before.profileId }).books.moveToFolder({ ids: [settings.id], folderId });
      }
      if (Object.keys(settings).length > 1) await caller.books.updateSettings(settings);
      // The call that puts a rename, a move or an author back, for the assistant panel's Undo.
      // Only those: a voice or an OCR engine is chosen, not slipped, and is not undone with a click.
      const undo: Record<string, unknown> = { id: settings.id };
      if (title !== undefined) undo.title = before.title;
      if (folder !== undefined) undo.folder = before.folderId;
      if (settings.author !== undefined) undo.author = before.author;
      return json({ ...(await getSummary(settings.id)), ...(Object.keys(undo).length > 1 ? { undo: { tool: "set_book_settings", input: undo } } : {}) });
    },
  );

  server.registerTool(
    "manage_folder",
    {
      description:
        "Create, rename or move a folder in the library. Folders are named by path from the top level (Work/Contracts). " +
        "create makes the path, parents included; rename gives one folder a new name; move puts it under another folder (or the top level with parent null). Nothing here deletes.",
      inputSchema: {
        action: z.enum(["create", "rename", "move"]),
        folder: z.string().trim().min(1).max(500).describe("The folder: a path such as Work/Contracts, or an id from list_books"),
        name: z.string().trim().min(1).max(200).optional().describe("rename: the new name"),
        parent: z.string().trim().min(1).max(500).nullable().optional().describe("move: the new parent's path or id; null for the top level"),
        profile: profileArg,
      },
    },
    async ({ action, folder, name, parent, profile }) => {
      const scope = await scoped(profile);
      const paths = async () => listFolderPaths(scope.profileId);
      switch (action) {
        case "create": {
          const id = await resolveFolderId(scope.profileId, folder, { create: true });
          return json({ id, path: (await paths()).find((f) => f.id === id)?.path ?? folder });
        }
        case "rename": {
          if (name === undefined) throw new Error("rename needs a name");
          const id = await resolveFolderId(scope.profileId, folder, { create: false });
          const before = (await paths()).find((f) => f.id === id);
          await scope.caller.folders.rename({ id, name });
          return json({ id, path: (await paths()).find((f) => f.id === id)?.path, undo: { tool: "manage_folder", input: { action: "rename", folder: id, name: before?.path.split("/").pop() ?? folder.split("/").pop() ?? folder } } });
        }
        case "move": {
          if (parent === undefined) throw new Error("move needs a parent (null for the top level)");
          const id = await resolveFolderId(scope.profileId, folder, { create: false });
          const parentId = parent === null ? null : await resolveFolderId(scope.profileId, parent, { create: false });
          const [before] = await db.select({ parentId: folders.parentId }).from(folders).where(eq(folders.id, id));
          await scope.caller.folders.move({ id, parentId });
          return json({ id, path: (await paths()).find((f) => f.id === id)?.path, undo: { tool: "manage_folder", input: { action: "move", folder: id, parent: before?.parentId ?? null } } });
        }
        default: {
          const unhandled: never = action;
          throw new Error(`unhandled action ${unhandled}`);
        }
      }
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
      description:
        "Search the text of every book in the library — extracted PDFs, OCR'd scans, books made with create_book and finished translations. Results cite the book, chapter and page. " +
        "Write the query in the language of the books. A book just uploaded is complete here once wait_for_book reaches \"searchable\". Keep an answer worth keeping with save_note.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        profile: profileArg,
        folder: z.string().trim().min(1).optional().describe("Only this folder and the folders inside it: a path such as Work/Contracts, or a folder id"),
        limit: z.number().int().min(1).max(30).optional(),
        mode: z.enum(["hybrid", "keyword"]).optional().describe("hybrid (default) adds semantic matches when the index is built"),
      },
    },
    async ({ profile, folder, ...input }) => {
      const scope = await scoped(profile);
      const folderId = folder === undefined ? undefined : await resolveFolderId(scope.profileId, folder, { create: false });
      return json(await scope.caller.search.library({ ...input, folderId }));
    },
  );

  server.registerTool(
    "save_note",
    {
      description:
        "Keep something you worked out — an answer with its citations, a summary, an analysis — as a note in the library, where the person sees it in the app and a later session finds it with list_notes. " +
        "With bookId it lands on that book's Notes tab; without, it is a library note in the profile. Markdown.",
      inputSchema: {
        title: z.string().trim().min(1).max(4000).describe("The question answered, or a short title"),
        markdown: z.string().min(1).max(1_000_000),
        bookId: bookId.optional(),
        profile: profileArg,
        author: z.string().trim().min(1).max(64).default("agent").describe("Who wrote it, e.g. the agent's name; shown beside the note"),
      },
    },
    async ({ title, markdown, bookId: id, profile, author }) => {
      if (id !== undefined) {
        const fileRows = await db.select({ id: bookFiles.id }).from(bookFiles).where(eq(bookFiles.bookId, id));
        const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, id));
        if (!book) throw new Error("Book not found");
        return json({ noteId: await saveNote({ bookId: id, prompt: title, model: author, result: markdown, scope: { kind: "book-raw", files: fileRows.length } }) });
      }
      const scope = await scoped(profile);
      return json({ noteId: await saveNote({ bookId: null, profileId: scope.profileId, prompt: title, model: author, result: markdown, scope: { kind: "library", question: title } }) });
    },
  );

  server.registerTool(
    "list_notes",
    {
      description:
        "Notes saved in the library, newest first: AI answers people saved from the app and notes written with save_note. Check here before redoing an analysis. " +
        "Without arguments it lists titles only; pass noteId to read one (long notes page through offset/maxChars), bookId for one book's notes, neither for the profile's library notes.",
      inputSchema: {
        noteId: z.string().uuid().optional(),
        bookId: bookId.optional(),
        profile: profileArg,
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1).max(200_000).default(20_000),
      },
    },
    async ({ noteId, bookId: id, profile, offset, maxChars }) => {
      if (noteId !== undefined) {
        const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
        if (!note) throw new Error("Note not found");
        return json({ id: note.id, bookId: note.bookId, title: note.prompt, author: note.model, createdAt: note.createdAt, ...page(note.result, offset, maxChars) });
      }
      const scope = await scoped(profile);
      const rows = await db
        .select({ id: notes.id, bookId: notes.bookId, title: notes.prompt, author: notes.model, chars: sql<number>`length(${notes.result})`, createdAt: notes.createdAt })
        .from(notes)
        .where(id !== undefined ? eq(notes.bookId, id) : and(isNull(notes.bookId), eq(notes.profileId, scope.profileId)))
        .orderBy(desc(notes.createdAt))
        .limit(200);
      return json(rows);
    },
  );

  return server;
}

const POLL_MS = 2000;
const MAX_LOG_ENTRIES = 300;

function page(text: string, offset: number, maxChars: number) {
  return { totalChars: text.length, offset, truncated: offset + maxChars < text.length, text: text.slice(offset, offset + maxChars) };
}

// A PDF an agent names: a path on this machine, or a file the assistant panel staged for it. A
// staged file keeps the name it was dropped with — on disk it is called by its id.
async function resolvePdfSource(p: string, profileId: string): Promise<{ path: string; filename: string }> {
  if (isStagedRef(p)) {
    const staged = await resolveStaged(p, profileId);
    return { path: staged.path, filename: staged.record.filename };
  }
  if (!path.isAbsolute(p)) throw new Error(`Not an absolute path: ${p}`);
  if (!p.toLowerCase().endsWith(".pdf")) throw new Error(`Not a PDF: ${p}`);
  const info = await stat(p).catch(() => null);
  if (!info?.isFile()) throw new Error(`No such file: ${p}`);
  return { path: p, filename: path.basename(p) };
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
export type CompactBook = ReturnType<typeof compactBook>;

// One book as the tools see it: the router's view plus its outputs and the last log line
export async function loadBook(caller: Caller, id: string): Promise<CompactBook> {
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
}

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
    searchIndex: book.searchIndex ? { status: book.searchIndex.status, progress: book.searchIndex.progress ?? null, error: book.searchIndex.error ?? null } : null,
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

// What wait_for_book and every action tool answer with: counts, and in detail only what went wrong.
export function summarizeBook(book: CompactBook) {
  const byStatus: Partial<Record<Chapter["status"], number>> = {};
  for (const c of book.chapters) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  return {
    id: book.id,
    title: book.title,
    kind: book.kind,
    status: book.status,
    error: book.error,
    latestLog: book.latestLog,
    language: book.language,
    voice: book.voice,
    folderId: book.folderId,
    totalWords: book.totalWords,
    files: {
      total: book.files.length,
      withText: book.files.filter((f) => f.hasRawText).length,
      withoutText: book.files.filter((f) => !f.hasRawText).map((f) => ({ index: f.index, filename: f.filename, status: f.status, error: f.error })),
    },
    chapters: {
      total: book.chapters.length,
      selected: book.chapters.filter((c) => c.selected).length,
      withAudio: book.chapters.filter((c) => c.hasAudio).length,
      byStatus,
      failed: book.chapters.filter((c) => c.status === "failed").map((c) => ({ id: c.id, index: c.index, title: c.title, error: c.error })),
    },
    searchIndex: book.searchIndex,
    outputPath: book.outputPath,
    downloadUrl: book.downloadUrl,
    assembleQueued: book.assembleQueued,
    assemblies: book.assemblies.length,
    documents: book.documents.map((d) => ({ id: d.id, format: d.format, language: d.language, downloadUrl: d.downloadUrl })),
  };
}

// Jobs still owed to a book. A job that failed stays in the table with its attempts spent
// (maxAttempts is 1 everywhere), so presence alone proves nothing; and a running one has spent
// its attempt too, which is why the lock counts as well.
export type QueuedWork = { text: boolean; index: boolean };

const TEXT_TASKS = ["rawExtract", "ocrTextLayer"];
const INDEX_TASKS = ["indexBook", "embedChunks"];

async function queuedWork(bookId: string): Promise<QueuedWork> {
  const [probe] = (await db.execute(
    sql`SELECT to_regclass('graphile_worker._private_jobs') AS jobs_table`,
  )) as unknown as Array<{ jobs_table: string | null }>;
  if (!probe?.jobs_table) return { text: false, index: false };
  const rows = (await db.execute(sql`
    SELECT DISTINCT t.identifier
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    WHERE j.payload->>'bookId' = ${bookId} AND (j.locked_at IS NOT NULL OR j.attempts < j.max_attempts)
  `)) as unknown as Array<{ identifier: string }>;
  const owed = new Set(rows.map((r) => r.identifier));
  return { text: TEXT_TASKS.some((t) => owed.has(t)), index: INDEX_TASKS.some((t) => owed.has(t)) };
}

const AUDIO_IN_FLIGHT = new Set(["pending", "normalizing", "synthesizing"]);
const EXTRACTION_IN_FLIGHT = new Set(["pending", "extracting"]);

function audioSettled(book: CompactBook): boolean {
  return !book.chapters.some((c) => c.selected && AUDIO_IN_FLIGHT.has(c.status));
}

export const WAIT_STAGES = ["text", "searchable", "chapters", "audio", "output"] as const;

// One file with text used to satisfy "text" for the whole book, so a caller was told a
// seventeen-file book was ready while OCR was on page 11 of its first scan, searched it, and
// concluded the answer was not there.
function textSettled(book: CompactBook, extracting: boolean, queued: QueuedWork): { satisfied: boolean; reason?: string } | null {
  // A book written with create_book has no files; its chapters are its text.
  if (book.files.length === 0) return book.chapters.length > 0 ? { satisfied: true } : null;
  // Raw text lands in seconds and the thorough page read runs for half an hour after it, so
  // "extracting" alone must not hold this back — only a file that still has nothing to show.
  if (book.files.every((f) => f.hasRawText)) return { satisfied: true };
  if (extracting || queued.text) return null;
  // Nothing is left to run: the files without text were read and had none, and the summary names them.
  if (book.files.some((f) => f.hasRawText)) return { satisfied: true };
  return { satisfied: false, reason: "No file yielded any text — the PDFs may be encrypted or empty; get_book with logs=true says what each one reported" };
}

export function stageReached(book: CompactBook, until: (typeof WAIT_STAGES)[number], queued: QueuedWork): { satisfied: boolean; reason?: string } | null {
  if (book.status === "failed") return { satisfied: false, reason: book.error ?? "failed" };
  const extracting = book.status === "extracting" || book.files.some((f) => EXTRACTION_IN_FLIGHT.has(f.status));
  switch (until) {
    case "text":
      return textSettled(book, extracting, queued);
    case "searchable": {
      // Whatever is still reading pages queues a reindex as its last act, and until then the
      // index's "done" describes the text as it was before.
      if (extracting || queued.text || queued.index) return null;
      const text = textSettled(book, extracting, queued);
      if (text?.satisfied !== true) return text;
      switch (book.searchIndex?.status) {
        case "done":
          return { satisfied: true };
        case "waiting":
          return { satisfied: true, reason: "Indexed for keyword search only — semantic search needs the embeddings bundle (get_capabilities)" };
        case "failed":
          return { satisfied: false, reason: book.searchIndex.error ?? "Indexing failed" };
        default:
          return null;
      }
    }
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
