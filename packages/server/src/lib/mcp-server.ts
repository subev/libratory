import { bilingualExportSchema, bilingualExportStatus, bilingualReadiness, recordingStatus } from "./bilingual-export.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appRouter } from "../router.ts";
import { computeBookStatus } from "../routes/books.ts";
import { db } from "../db.ts";
import { bilingualPreparations, bookFiles, bookLogs, books, chapters, chapterVariants, folders, notes, profiles, OCR_ENGINES, DEFAULT_OCR_ENGINE, type Chapter, type ChapterVariant } from "../schema.ts";
import { TRANSFORM_PRESETS } from "./transform-presets.ts";
import { variantKeySlug } from "./transform.ts";
import { and, asc, desc, eq, ilike, inArray, isNull, ne, sql } from "drizzle-orm";
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
import { chapterText } from "./chapter-text.ts";
import { consumeStaged, isStagedRef, resolveStaged } from "./staged-files.ts";
import { owedJobs } from "./owed-jobs.ts";
import { outputChapters } from "./output-readiness.ts";
import path from "node:path";
import { copyFile, rm, stat } from "node:fs/promises";

// The agent-facing surface: about twenty curated tools over the tRPC router, not the router
// itself. Every long job returns at once with a summary of the book; wait_for_book is how a caller
// blocks on it. Each request gets its own server (the transport is stateless), so this must stay cheap.
// Only get_book answers with every chapter: an agent pays for each token of a result and polls in
// loops, and a 300-chapter book repeated on every call was most of a session's context.
const PRESET_IDS = TRANSFORM_PRESETS.map((p) => p.id) as [string, ...string[]];
const PRESET_HELP = `Rewrite with a preset: ${TRANSFORM_PRESETS.map((p) => `${p.id} (${p.label})`).join(", ")}`;

// origin: where the HTTP client reached this server, so download links in results can be followed
// as they are; the in-process assistant has none and gets paths.
export function createMcpServer(profileId: string, { origin }: { origin?: string } = {}): McpServer {
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

  const getBook = (id: string) => loadBook(caller, id, origin);
  // bilingual: per translation, which selected chapters are paired for two-language reading and
  // export, and which are not — so an export is offered only when it can run. The summary names
  // only the chapters the next call acts on; get_book carries every list.
  const getSummary = async (id: string) => ({ ...summarizeBook(await getBook(id)), bilingual: compactReadiness(await bilingualReadiness(id)) });

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
        "The library's layout and its books: the profiles (separate workspaces; current marks the one listed), this profile's folders as paths with book counts, " +
        "and the books newest first with processing status and chapter counts. Start here to find a book id, or a profile or folder to put a new book in. " +
        "A large library is cut at `limit` — narrow it with `query` (words from the title) or `folder`. A query searches every folder, leaves the folder list out, " +
        "and names matches in the other profiles under elsewhere — when a title is in more than one place, ask which copy is meant.",
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
      const pattern = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null;
      const where = and(
        eq(books.profileId, scope.profileId),
        folderId ? eq(books.folderId, folderId) : undefined,
        pattern ? ilike(books.title, pattern) : undefined,
      );
      const [[total], rows, profileList, folderList, elsewhere] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(books).where(where),
        db.select().from(books).where(where).orderBy(desc(books.createdAt)).limit(limit),
        listProfiles(scope.profileId),
        listFolderPaths(scope.profileId),
        // One query per profile made it look as if a book existed once: the same title in another
        // workspace was found only by listing each profile by hand.
        pattern && profile === undefined
          ? db.select({ id: books.id, title: books.title, profile: profiles.name }).from(books)
            .innerJoin(profiles, eq(books.profileId, profiles.id))
            .where(and(ne(books.profileId, scope.profileId), ilike(books.title, pattern)))
            .orderBy(desc(books.createdAt)).limit(20)
          : Promise.resolve([]),
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
        ...(query ? {} : { folders: folderList.map((f) => ({ id: f.id, path: f.path, books: f.books })) }),
        ...(elsewhere.length ? { elsewhere } : {}),
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
        "This is the one call that lists chapters — the other tools answer with a summary. Each narrated chapter says whether its recording carries word times (wordTiming): " +
        "one made before they existed does not, and then two-language word links show only on tap until synthesize_book narrates it again. " +
        "bilingual lists, per translation, the selected chapters still untranslated, unpaired or unlinked, and linkSpend — the tokens its word links have cost so far. " +
        "logs=true adds the processing log (OCR pages, narration chunks, failures; the newest 300 entries, logsOmitted counts the rest), logsAfter only the part of it after a timestamp; logsOnly answers with the status and that log alone, for polling.",
      inputSchema: {
        id: bookId,
        logs: z.boolean().default(false),
        logsAfter: z.string().datetime().optional().describe("Only log entries after this ISO timestamp; implies logs"),
        logsOnly: z.boolean().default(false).describe("Only the status, latest log line and the log — no chapters; implies logs"),
      },
    },
    async ({ id, logs, logsAfter, logsOnly }) => {
      if (logsOnly) {
        const [book, entries] = await Promise.all([getBook(id), caller.books.logs({ bookId: id, after: logsAfter })]);
        return json({ id, title: book.title, status: book.status, error: book.error, latestLog: book.latestLog, logsOmitted: Math.max(0, entries.length - MAX_LOG_ENTRIES), logs: entries.slice(-MAX_LOG_ENTRIES) });
      }
      const [book, timing, bilingual] = await Promise.all([getBook(id), recordingWordTiming(id), readinessWithSpend(id)]);
      const detail = { ...book, chapters: book.chapters.map((c) => ({ ...c, wordTiming: timing.get(c.id) ?? null })), bilingual };
      const noteRows = await db
        .select({ id: notes.id, title: notes.prompt, author: notes.model, chars: sql<number>`length(${notes.result})`, createdAt: notes.createdAt })
        .from(notes)
        .where(eq(notes.bookId, id))
        .orderBy(desc(notes.createdAt));
      if (!logs && logsAfter === undefined) return json({ ...detail, notes: noteRows });
      // A narrated book logs every chunk; the end of the log is where the answer is.
      const entries = await caller.books.logs({ bookId: id, after: logsAfter });
      return json({ ...detail, notes: noteRows, logsOmitted: Math.max(0, entries.length - MAX_LOG_ENTRIES), logs: entries.slice(-MAX_LOG_ENTRIES) });
    },
  );

  server.registerTool(
    "wait_for_book",
    {
      description:
        "Block until a book reaches a stage, or the timeout passes, then return a summary of it. Stages: \"text\" (every file has been read, OCR of scanned files included), " +
        "\"searchable\" (that text is indexed, so search_library sees all of it), \"chapters\" (chapter detection finished), \"translation\" (translate_book has finished; with language, that version), " +
        "\"audio\" (no chapter still narrating; with language, that translation's narration), " +
        "\"bilingual\" (prepare_bilingual's pairs and links have finished; with language, for that translation — a timeout says which chapter is at which batch, and the answer what the links cost in tokens), \"document\" (no export_book still queued or running; answers with the newest document), \"output\" (the M4B is assembled). " +
        "Returns early when the book fails, and \"translation\", \"audio\" or \"bilingual\" when that work failed. A failure more than an hour old is named in reason but does not fail the wait — without language for translation and audio, always for bilingual, whose failures stay on a chapter until it is prepared again. " +
        "Call again if it times out — the work keeps running. The default timeout fits under the usual 60 s client limit; raise it only if the client allows longer calls.",
      inputSchema: {
        id: bookId,
        until: z.enum(WAIT_STAGES).default("output"),
        language: z.string().min(1).optional().describe("For translation, audio and bilingual: the version's key as get_book lists it under variants"),
        timeoutSeconds: z.number().int().min(1).max(600).default(50),
      },
    },
    async ({ id, until, language, timeoutSeconds }, extra) => {
      const started = Date.now();
      const deadline = started + timeoutSeconds * 1000;
      const progressToken = progressTokenOf(extra);
      const key = language === undefined ? undefined : await laneKey(id, language);
      for (;;) {
        const [book, queued] = await Promise.all([getBook(id), queuedWork(id, key)]);
        const outcome = stageReached(book, until, queued, key);
        const elapsedSeconds = Math.round((Date.now() - started) / 1000);
        if (outcome) {
          const extras = until === "bilingual" ? { bilingual: await readinessWithSpend(id) }
            : until === "document" ? { document: book.documents[0] ?? null }
            : {};
          return json({ ...outcome, elapsedSeconds, ...extras, book: summarizeBook(book) });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || extra.signal.aborted) {
          const progress = until === "bilingual" ? { bilingual: compactReadiness(await bilingualReadiness(id)), inProgress: queued.bilingual?.active ?? [] } : {};
          return json({ satisfied: false, reason: "timeout", elapsedSeconds, ...progress, book: summarizeBook(book) });
        }
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
      description: "A chapter with the text the narrator reads (edited text, else cleaned, else raw), or with language the translation or rewrite of it — to check it before paying for narration or links. Long chapters page through offset/maxChars.",
      inputSchema: {
        id: chapterId,
        language: z.string().min(1).optional().describe("Read this translation or rewrite instead: its key as get_book lists it under variants"),
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1).max(200_000).default(20_000),
      },
    },
    async ({ id, language, offset, maxChars }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id));
      if (!chapter) throw new Error("Chapter not found");
      if (language !== undefined) {
        const key = await laneKey(chapter.bookId, language);
        const [variant] = await db.select().from(chapterVariants).where(and(eq(chapterVariants.chapterId, id), eq(chapterVariants.key, key)));
        if (!variant) throw new Error(`"${chapter.title}" has no ${key} version — translate_book makes one`);
        return json({
          id: chapter.id,
          bookId: chapter.bookId,
          index: chapter.index,
          language: key,
          kind: variant.kind,
          title: variant.title ?? chapter.title,
          status: variant.status,
          error: variant.error,
          audioStatus: variant.audioStatus,
          audioError: variant.audioError,
          hasAudio: variant.audioStatus === "done" && variant.audioPath !== null,
          ...page(variant.text, offset, maxChars),
        });
      }
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
        "With language, narrate that translation's lane instead (its key as get_book lists it under variants), with voice and speed setting the lane's own narrator first — pick one for that language from list_voices; without them the lane keeps its voice, or the book's. " +
        "A metered cloud voice answers with estimate: the characters it will bill — Cartesia charges about one credit per character and has no way to read the balance ahead, so a run the plan cannot cover fails on its first chunk and spends nothing. dryRun answers with that estimate alone. " +
        "Then wait_for_book until \"audio\" (with the same language for a lane), or assemble_book with waitForAll.",
      inputSchema: {
        id: bookId, chapterIds: z.array(chapterId).min(1).optional(), resume: z.boolean().default(false),
        language: z.string().min(1).optional().describe("Narrate this translation or rewrite instead of the original: its key as get_book lists it under variants"),
        voice: z.string().min(1).optional().describe("Narrator voice id from list_voices for the lane named by language"),
        speed: z.number().min(0.5).max(2).optional(),
        dryRun: z.boolean().default(false).describe("Only answer with estimate — nothing is queued and no voice is changed"),
      },
    },
    async ({ id, chapterIds, resume, language, voice, speed, dryRun }) => {
      if ((voice !== undefined || speed !== undefined) && language === undefined) throw new Error("voice and speed set a lane's narrator: pass language too, or use set_book_settings for the book's voice");
      if (voice !== undefined) parseTtsVoice(voice);
      const key = language === undefined ? undefined : await laneKey(id, language);
      const estimate = await meteredEstimate(id, key, chapterIds, voice);
      if (dryRun) return json({ dryRun: true, estimate: estimate ?? { voice: voice ?? null, metered: false } });
      if (key !== undefined) {
        if (voice !== undefined || speed !== undefined) await caller.variants.setVoice({ bookId: id, key, ...(voice !== undefined ? { voice } : {}), ...(speed !== undefined ? { speed } : {}) });
        if (chapterIds) for (const chapter of chapterIds) await caller.variants.queueAudio({ chapterId: chapter, key, resume });
        else await caller.variants.processSelectedAudio({ bookId: id, key });
      } else if (chapterIds) for (const chapter of chapterIds) await caller.chapters.queue({ id: chapter, resume });
      else await caller.books.processSelected({ id });
      return json({ ...(estimate ? { estimate } : {}), ...(await getSummary(id)) });
    },
  );

  server.registerTool(
    "translate_book",
    {
      description:
        "Make a second version of the chapters beside the original: a translation into a language, or an AI rewrite (a preset, or your own instruction). Each chapter's text goes through the AI model, so it costs tokens and minutes per chapter. " +
        "Every selected chapter, or only chapterIds (which redoes them even when finished); selected chapters that already have this version finished are skipped. " +
        "Runs in the background — wait_for_book until \"translation\" with the answer's key. The version is listed under variants in get_book, has its own lane in the book page's language menu, and once done can be narrated and exported (export_book with language). This is how a book is translated — export_book only writes out a version that exists.",
      inputSchema: {
        id: bookId,
        language: z.string().trim().min(1).max(40).optional().describe("Translate into this language, by its English name as the app lists it: German, Bulgarian, Spanish — never a code"),
        preset: z.enum(PRESET_IDS).optional().describe(PRESET_HELP),
        prompt: z.string().trim().min(1).max(2000).optional().describe("Rewrite with your own instruction instead of a preset"),
        label: z.string().trim().min(1).max(40).optional().describe("Name for a prompt rewrite, shown in the app; inferred from the prompt when omitted"),
        chapterIds: z.array(chapterId).min(1).optional().describe("Only these chapters; omit for every selected chapter"),
      },
    },
    async ({ id, language, preset, prompt, label, chapterIds }) => {
      if ([language, preset, prompt].filter((v) => v !== undefined).length !== 1) throw new Error("Pass exactly one of language, preset or prompt");
      if (language && /^[a-z]{2}([-_][a-z]{2,4})?$/i.test(language)) {
        throw new Error(`Pass the language's English name, e.g. German — "${language}" is a code and would become a version of its own`);
      }
      const targets = chapterIds
        ? await db.select({ id: chapters.id }).from(chapters).where(and(eq(chapters.bookId, id), inArray(chapters.id, chapterIds)))
        : null;
      if (targets && targets.length !== chapterIds?.length) throw new Error("A chapter is not in this book");

      // Selected chapters that already have the version, or are getting it, are left alone; named ones are redone
      const doneFor = async (key: string): Promise<Set<string>> => {
        if (targets) return new Set();
        const rows = await db
          .select({ chapterId: chapterVariants.chapterId })
          .from(chapterVariants)
          .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
          .where(and(eq(chapters.bookId, id), eq(chapterVariants.key, key), inArray(chapterVariants.status, ["done", "pending", "translating"])));
        return new Set(rows.map((r) => r.chapterId));
      };

      if (prompt !== undefined) {
        const rows = targets ?? await db.select({ id: chapters.id }).from(chapters).where(and(eq(chapters.bookId, id), eq(chapters.selected, true))).orderBy(asc(chapters.index));
        if (rows.length === 0) throw new Error("No chapters are selected");
        // The version is named by the label, else by the first call from the prompt; the rest join it by that name
        let name = label;
        let key = name ? await laneKey(id, `custom-${variantKeySlug(name)}`) : null;
        let skip = key ? await doneFor(key) : new Set<string>();
        let queued = 0;
        for (const row of rows) {
          if (skip.has(row.id)) continue;
          const variant = await caller.variants.createTransform({ chapterId: row.id, prompt, ...(name ? { label: name } : {}) });
          if (!variant) throw new Error("Failed to create the variant");
          queued += 1;
          if (!key) {
            key = variant.key;
            name = variant.label ?? undefined;
            skip = await doneFor(key);
          }
        }
        if (queued === 0) throw new Error(`Every selected chapter already has "${name}" or is getting it`);
        return json({ key, queued, ...(await getSummary(id)) });
      }

      const key = await laneKey(id, language !== undefined ? titleCase(language) : preset ?? "");
      if (!key) throw new Error("Pass exactly one of language, preset or prompt");
      let queued: number;
      if (targets) {
        for (const row of targets) await caller.variants.start({ chapterId: row.id, key });
        queued = targets.length;
      } else {
        ({ queued } = await caller.variants.processSelected({ bookId: id, key }));
      }
      return json({ key, queued, ...(await getSummary(id)) });
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
      description:
        "Export the selected chapters, or only chapterIds, as a document: pdf, epub, epub-sync (single-language text plus narration), or epub-bilingual (original plus a prepared translation). " +
        "For epub-bilingual, language selects the translation and bilingual selects available recordings; every exported chapter must be translated and paired — get_book's bilingual field lists the ones that are not, and prepare_bilingual pairs them. " +
        "Its pages show the original text; the translation, sentence pairs and word links travel as a reading layer that Libratory's reader shows, so another EPUB reader shows the original alone. " +
        "Answers with warnings when a recording has no word times (word links then show on tap only) or links are missing. Then wait_for_book until \"document\", which answers with the file.",
      inputSchema: {
        id: bookId,
        format: z.enum(["pdf", "epub", "epub-sync", "epub-bilingual"]),
        bilingual: bilingualExportSchema.optional(),
        language: z.string().min(1).optional().describe("Export a finished version instead of the original: its key as get_book lists it under variants — a language name such as German, or a rewrite's key. translate_book makes one"),
        chapterIds: z.array(chapterId).min(1).optional().describe("Only these chapters, whatever is selected"),
        waitForAll: z.boolean().default(true),
      },
    },
    async (input) => {
      const language = input.language === undefined ? undefined : await laneKey(input.id, input.language);
      let warnings: string[] = [];
      if (input.format === "epub-bilingual" && language !== undefined && input.bilingual) {
        const rows = await bilingualExportStatus(input.id, language, input.chapterIds);
        const untranslated = rows.filter((r) => !r.translated);
        if (untranslated.length) throw new Error(`No finished ${language} translation for ${chapterList(untranslated)} — translate_book with those chapterIds, or leave them out with chapterIds`);
        const unpaired = rows.filter((r) => !r.paired);
        if (unpaired.length) throw new Error(`Not paired yet: ${chapterList(unpaired)} — prepare_bilingual stage "pairs" with language "${language}", then wait_for_book until "bilingual"`);
        warnings = bilingualWarnings(rows, input.bilingual);
      }
      await caller.books.exportDocument({ ...input, language });
      return json({ ...(warnings.length ? { warnings } : {}), next: "wait_for_book until \"document\"", ...(await getSummary(input.id)) });
    },
  );

  server.registerTool(
    "prepare_bilingual",
    {
      description:
        "Prepare two-language reading for the selected chapters of a finished translation, the step before export_book epub-bilingual. " +
        "stage pairs matches each original sentence with its translated sentence with the local search model (free; needs the search bundle from get_capabilities). " +
        "stage links asks the AI model to link the words inside matched sentences (costs a few cents per chapter) and needs pairs first. " +
        "Only missing or stale work is requested; runs in the background — wait_for_book until \"bilingual\" with the same language. " +
        "Links light up as the voice reads only over a recording with word times; warnings name the chapters whose recording has none, which synthesize_book can narrate again.",
      inputSchema: {
        id: bookId,
        language: z.string().min(1).describe("The translation's key as get_book lists it under variants — a language name such as German"),
        stage: z.enum(["pairs", "links"]),
        model: modelKeySchema.optional().describe("AI model for stage links; the default model when omitted"),
        chapterIds: z.array(chapterId).min(1).optional().describe("Only these chapters; the selected chapters when omitted"),
      },
    },
    async ({ id, language, stage, model, chapterIds }) => {
      const key = await laneKey(id, language);
      const ids = chapterIds ?? (await db.select({ id: chapters.id }).from(chapters).where(outputChapters(id)).orderBy(asc(chapters.index))).map((r) => r.id);
      if (ids.length === 0) throw new Error("No chapters selected — select some with update_chapter or pass chapterIds");
      const results = await caller.bilingual.prepareSelection({ bookId: id, chapterIds: ids, key, stage, ...(model ? { model } : {}) });
      const warnings = bilingualWarnings(await bilingualExportStatus(id, key, ids), { sourceAudio: true, targetAudio: true }, { links: false, missing: false });
      return json({
        queued: results.filter((r) => r.queued).length,
        errors: results.filter((r) => r.error).map((r) => ({ chapterId: r.chapterId, error: r.error })),
        ...(warnings.length ? { warnings } : {}),
        next: `wait_for_book until "bilingual" with language "${key}"`,
        ...(await getSummary(id)),
      });
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
        "and whether its recordings carry word timing (wordTiming: true — words light up as read, and two-language reading links words; false means sentence level: Kokoro's non-English voices, Pocket, KugelAudio, the Bulgarian narrators and macOS voices). " +
        "and cloud ones behind a configured key (Cartesia, ElevenLabs — metered). Filter by language code to find a voice for a book; " +
        "with a language filter, native: false marks a voice that reads it in another language's accent (every ElevenLabs voice is listed under every language its model reads) — prefer native ones.",
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
export async function loadBook(caller: Caller, id: string, origin?: string): Promise<CompactBook> {
  const [book, assemblies, documents, [latestLog], variantRows] = await Promise.all([
    caller.books.get({ id }),
    caller.books.assemblies({ bookId: id }),
    caller.books.documents({ bookId: id }),
    db
      .select({ message: bookLogs.message, createdAt: bookLogs.createdAt })
      .from(bookLogs)
      .where(eq(bookLogs.bookId, id))
      .orderBy(desc(bookLogs.createdAt))
      .limit(1),
    db
      .select({ key: chapterVariants.key, kind: chapterVariants.kind, label: chapterVariants.label, status: chapterVariants.status, error: chapterVariants.error, audioStatus: chapterVariants.audioStatus, audioError: chapterVariants.audioError, updatedAt: chapterVariants.updatedAt, chapterIndex: chapters.index })
      .from(chapterVariants)
      .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
      .where(eq(chapters.bookId, id))
      .orderBy(asc(chapterVariants.createdAt)),
  ]);
  return compactBook(book, assemblies, documents, latestLog ?? null, summarizeVariants(variantRows), origin ?? "");
}

// "german" and "German" are one version, not two: a key the book already has wins over its spelling
async function laneKey(bookId: string, key: string): Promise<string> {
  const rows = await db
    .selectDistinct({ key: chapterVariants.key })
    .from(chapterVariants)
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(and(eq(chapters.bookId, bookId), sql`lower(${chapterVariants.key}) = lower(${key})`));
  return rows[0]?.key ?? key;
}

// "chinese (simplified)" → "Chinese (Simplified)", the spelling the app's language list uses
function titleCase(name: string): string {
  return name.replace(/(^|[\s(])([a-zà-ÿ])/g, (_, before: string, letter: string) => before + letter.toUpperCase());
}

// The translations and rewrites a book has, one line per version: the model has to see that
// "German" exists before it can export it, and that it does not before it offers to
// A narration that failed is named with its error: a Cartesia refusal once showed only as the book's
// last log line, and waiting for "audio" reported success.
// failedAt / audioFailedAt: the latest failure, so a wait can tell this run's refusal from last month's.
type VariantRow = Pick<ChapterVariant, "key" | "kind" | "label" | "status" | "error" | "audioStatus" | "audioError" | "updatedAt"> & { chapterIndex: number };
export type VariantSummary = {
  key: string; kind: VariantRow["kind"]; label: string | null;
  chapters: { total: number; done: number; running: number; failed: number };
  error: string | null; failedAt: Date | null;
  // Which chapters have this version at all, by index; get_book only
  chapterIndexes: number[];
  withAudio: number; narrating: number; audioFailed: number; audioError: string | null; audioFailedAt: Date | null;
};

const later = (a: Date | null, b: Date) => (a === null || b > a ? b : a);

export function summarizeVariants(rows: VariantRow[]): VariantSummary[] {
  const byKey = new Map<string, VariantSummary>();
  for (const r of rows) {
    let lane = byKey.get(r.key);
    if (!lane) {
      lane = { key: r.key, kind: r.kind, label: r.label, chapters: { total: 0, done: 0, running: 0, failed: 0 }, error: null, failedAt: null, chapterIndexes: [], withAudio: 0, narrating: 0, audioFailed: 0, audioError: null, audioFailedAt: null };
      byKey.set(r.key, lane);
    }
    lane.chapters.total += 1;
    lane.chapterIndexes.push(r.chapterIndex);
    if (r.status === "done") lane.chapters.done += 1;
    else if (r.status === "failed") {
      lane.chapters.failed += 1;
      lane.error ??= r.error;
      lane.failedAt = later(lane.failedAt, r.updatedAt);
    } else if (r.status === "pending" || r.status === "translating") lane.chapters.running += 1;
    if (r.audioStatus === "done") lane.withAudio += 1;
    else if (r.audioStatus === "pending" || r.audioStatus === "synthesizing") lane.narrating += 1;
    else if (r.audioStatus === "failed") {
      lane.audioFailed += 1;
      lane.audioError ??= r.audioError;
      lane.audioFailedAt = later(lane.audioFailedAt, r.updatedAt);
    }
  }
  for (const lane of byKey.values()) lane.chapterIndexes.sort((a, b) => a - b);
  return [...byKey.values()];
}

function compactBook(
  book: BookDetail,
  assemblies: Awaited<ReturnType<Caller["books"]["assemblies"]>>,
  documents: Awaited<ReturnType<Caller["books"]["documents"]>>,
  latestLog: { message: string; createdAt: Date } | null,
  variants: VariantSummary[],
  origin: string,
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
    downloadUrl: book.outputPath ? `${origin}/download/${book.id}` : null,
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
    assemblies: assemblies.map((a) => ({ id: a.id, outputPath: a.outputPath, sizeBytes: a.sizeBytes, createdAt: a.createdAt, downloadUrl: `${origin}/download/assembly/${a.id}` })),
    documents: documents.map((d) => ({ id: d.id, format: d.format, language: d.language, outputPath: d.outputPath, sizeBytes: d.sizeBytes, createdAt: d.createdAt, downloadUrl: `${origin}/download/document/${d.id}` })),
    variants,
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
    variants: book.variants.map((lane) => ({
      key: lane.key, kind: lane.kind, label: lane.label, chapters: lane.chapters, error: lane.error, failedAt: lane.failedAt,
      withAudio: lane.withAudio, narrating: lane.narrating, audioFailed: lane.audioFailed, audioError: lane.audioError, audioFailedAt: lane.audioFailedAt,
    })),
  };
}

// Jobs still owed to a book.
// bilingual is read from the preparation rows rather than the queue: they carry the failure too,
// and a run is marked queued there before its job exists.
// active names each run and how far it got, because readiness counts whole chapters and sat still
// through the half hour one long chapter took to link.
// failed carries each failure's time: a failed row stays failed until that chapter is prepared
// again, and the boot sweep fails every run a restart interrupted, so without one an old failure
// on a chapter nobody asked about ended every later wait.
export type QueuedWork = { text: boolean; index: boolean; document?: boolean; bilingual?: { running: number; failed: { text: string; at: Date | null }[]; active: string[] } };

const TEXT_TASKS = ["rawExtract", "ocrTextLayer"];
const INDEX_TASKS = ["indexBook", "embedChunks"];

async function queuedWork(bookId: string, key?: string): Promise<QueuedWork> {
  const [bilingual, owed] = await Promise.all([bilingualWork(bookId, key), owedJobs(bookId)]);
  return { text: TEXT_TASKS.some((t) => owed.has(t)), index: INDEX_TASKS.some((t) => owed.has(t)), document: owed.has("assembleDocument"), bilingual };
}

async function bilingualWork(bookId: string, key?: string): Promise<QueuedWork["bilingual"]> {
  const rows = await db
    .select({ title: chapters.title, pairJob: bilingualPreparations.pairJob, linkJob: bilingualPreparations.linkJob })
    .from(bilingualPreparations)
    .innerJoin(chapterVariants, eq(bilingualPreparations.variantId, chapterVariants.id))
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(and(eq(chapters.bookId, bookId), key === undefined ? undefined : eq(chapterVariants.key, key)));
  let running = 0;
  const failed: { text: string; at: Date | null }[] = [];
  const active: string[] = [];
  for (const row of rows) {
    for (const [stage, job] of [["pairs", row.pairJob], ["links", row.linkJob]] as const) {
      if (job?.status === "queued" || job?.status === "running") {
        running += 1;
        active.push(`${row.title} (${stage}): ${job.status === "queued" ? "queued" : `${job.done}/${job.total}${stage === "links" ? " batches" : ""}`}`);
      } else if (job?.status === "failed") {
        const at = Number.isNaN(Date.parse(job.updatedAt)) ? null : new Date(job.updatedAt);
        failed.push({ text: `${row.title} (${stage}${at ? `, ${at.toISOString()}` : ""}): ${job.error ?? "failed"}`, at });
      }
    }
  }
  return { running, failed, active };
}

// What the word links on a translation have cost so far, retried batches included: the tokens are
// recorded per batch, and until this no tool added them up. Tokens rather than money — the price
// table is models.dev's, often not cached, and a guessed price is worse than none.
async function linkSpend(bookId: string): Promise<Map<string, { batches: number; inputTokens: number; outputTokens: number; models: string[] }>> {
  const rows = await db
    .select({ key: chapterVariants.key, links: bilingualPreparations.links })
    .from(bilingualPreparations)
    .innerJoin(chapterVariants, eq(bilingualPreparations.variantId, chapterVariants.id))
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(eq(chapters.bookId, bookId));
  const spend = new Map<string, { batches: number; inputTokens: number; outputTokens: number; models: string[] }>();
  for (const { key, links } of rows) {
    if (!links?.batches.length) continue;
    const lane = spend.get(key) ?? { batches: 0, inputTokens: 0, outputTokens: 0, models: [] };
    for (const batch of links.batches) {
      lane.batches += 1;
      lane.inputTokens += batch.inputTokens;
      lane.outputTokens += batch.outputTokens;
      if (!lane.models.includes(batch.model)) lane.models.push(batch.model);
    }
    spend.set(key, lane);
  }
  return spend;
}

async function readinessWithSpend(bookId: string) {
  const [lanes, spend] = await Promise.all([bilingualReadiness(bookId), linkSpend(bookId)]);
  return lanes.map((lane) => ({ ...lane, linkSpend: spend.get(lane.key) ?? null }));
}

const AUDIO_IN_FLIGHT = new Set(["pending", "normalizing", "synthesizing"]);
const EXTRACTION_IN_FLIGHT = new Set(["pending", "extracting"]);

// A lane's narration counts too: synthesize_book with language runs there, and a caller waiting
// for "audio" wants that recording as much as the original's
function audioSettled(book: CompactBook): boolean {
  return !book.chapters.some((c) => c.selected && AUDIO_IN_FLIGHT.has(c.status)) && !book.variants.some((lane) => lane.narrating > 0);
}

const RECENT_FAILURE_MS = 60 * 60 * 1000;

// A lane's failed narration or translation. With a key only that lane speaks, and any failure of it
// ends the wait. Without one every lane does, so a refusal right after synthesize_book language is
// never read as the recording being ready — but only a recent failure: narrating the original once
// reported a Bulgarian narration that had failed a month before. An older one is still named, as a
// note on a satisfied wait.
function laneFailures(book: CompactBook, what: "narration" | "translation", key: string | undefined, now: number): { satisfied: boolean; reason?: string } {
  const failures = book.variants.flatMap((lane) => {
    if (key !== undefined && lane.key !== key) return [];
    const [count, error, at] = what === "narration" ? [lane.audioFailed, lane.audioError, lane.audioFailedAt] : [lane.chapters.failed, lane.error, lane.failedAt];
    if (count === 0) return [];
    const when = at ? ` at ${at.toISOString()}` : "";
    return [{ recent: key !== undefined || at === null || now - at.getTime() < RECENT_FAILURE_MS, text: `${lane.key} ${what} failed for ${count} chapter${count === 1 ? "" : "s"}${when}: ${error ?? "no error recorded"}` }];
  });
  const recent = failures.filter((f) => f.recent);
  if (recent.length) return { satisfied: false, reason: recent.map((f) => f.text).join("; ") };
  if (failures.length) return { satisfied: true, reason: `An older failure, not from this run: ${failures.map((f) => f.text).join("; ")}` };
  return { satisfied: true };
}

export const WAIT_STAGES = ["text", "searchable", "chapters", "translation", "audio", "bilingual", "document", "output"] as const;

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

export function stageReached(book: CompactBook, until: (typeof WAIT_STAGES)[number], queued: QueuedWork, key?: string, now = Date.now()): { satisfied: boolean; reason?: string } | null {
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
    case "translation": {
      if (key !== undefined) {
        const lane = book.variants.find((v) => v.key === key);
        if (!lane) return { satisfied: false, reason: `No ${key} version — translate_book makes one` };
        if (lane.chapters.running > 0) return null;
      } else if (book.variants.length === 0) return { satisfied: false, reason: "No translation or rewrite — translate_book makes one" };
      else if (book.variants.some((lane) => lane.chapters.running > 0)) return null;
      return laneFailures(book, "translation", key, now);
    }
    case "audio": {
      if (key !== undefined) {
        const lane = book.variants.find((v) => v.key === key);
        if (!lane) return { satisfied: false, reason: `No ${key} version — translate_book makes one` };
        if (lane.narrating > 0) return null;
      } else if (book.chapters.length === 0 || extracting || !audioSettled(book)) return null;
      return laneFailures(book, "narration", key, now);
    }
    case "bilingual": {
      // An unknown language finds no preparation rows, which read as nothing left to wait for
      if (key !== undefined && !book.variants.some((v) => v.key === key)) return { satisfied: false, reason: `No ${key} version — translate_book makes one` };
      const work = queued.bilingual ?? { running: 0, failed: [], active: [] };
      if (work.running > 0) return null;
      const recent = work.failed.filter((f) => f.at === null || now - f.at.getTime() < RECENT_FAILURE_MS);
      if (recent.length) return { satisfied: false, reason: `Preparation failed: ${recent.map((f) => f.text).join("; ")}` };
      if (work.failed.length) return { satisfied: true, reason: `An older failure, not from this run: ${work.failed.map((f) => f.text).join("; ")}` };
      return { satisfied: true };
    }
    case "document":
      return queued.document || book.status === "assembling" ? null : { satisfied: true };
    case "output":
      // processSelected re-narrates without clearing outputPath, so the old M4B alone is not the answer
      return book.outputPath !== null && book.status !== "assembling" && !book.assembleQueued && audioSettled(book)
        ? { satisfied: true }
        : null;
  }
}

// The readiness a summary carries: the chapters the next call acts on by id, the rest counted
function compactReadiness(lanes: Awaited<ReturnType<typeof bilingualReadiness>>) {
  return lanes.map(({ untranslated, unlinked, ...lane }) => ({ ...lane, untranslated: untranslated.length, unlinked: unlinked.length }));
}

function chapterList(rows: { id: string; index: number; title: string }[]): string {
  const named = rows.slice(0, 10).map((r) => `${r.index + 1}. ${r.title} (${r.id})`).join(", ");
  return rows.length > 10 ? `${named} and ${rows.length - 10} more` : named;
}

type ExportStatusRow = Awaited<ReturnType<typeof bilingualExportStatus>>[number];

// What a two-language export will lack without failing: a recording with no word times plays with
// passage highlights and word links only on tap. The first dogfood export shipped exactly that,
// 1,035 links that never lit up, because a recording from before word timings looked like any other.
// missing: whether a chapter with no recording at all is worth a word — to an export it is, to
// pairing it is not, and mid-narration every chapter still in the queue looked like one.
function bilingualWarnings(rows: ExportStatusRow[], audio: { sourceAudio: boolean; targetAudio: boolean }, { links = true, missing = true } = {}): string[] {
  const warnings: string[] = [];
  const untimed = (side: "source" | "target") => rows.filter((r) => r[side].available && !r[side].words);
  if (audio.sourceAudio) {
    const original = untimed("source");
    if (original.length) warnings.push(`The original recording has no word times for ${chapterList(original)}: its word links show on tap only. synthesize_book with those chapterIds narrates them again with word times (list_voices says which voices keep them).`);
    const silent = missing ? rows.filter((r) => !r.source.available) : [];
    if (silent.length) warnings.push(`No original recording for ${chapterList(silent)}: those chapters export as text.`);
  }
  if (audio.targetAudio) {
    const translation = untimed("target");
    if (translation.length) warnings.push(`The translation's recording has no word times for ${chapterList(translation)}: its words cannot light up as they are read.`);
  }
  if (links) {
    const unlinked = rows.filter((r) => r.paired && r.linkedGroups < r.matchedGroups);
    if (unlinked.length) warnings.push(`Word links are missing for ${chapterList(unlinked)} — prepare_bilingual stage "links" adds them.`);
  }
  return warnings;
}

// Per narrated chapter, whether its recording carries word times. Read from the sync maps, so only
// get_book pays for it — the summaries every other call returns do not.
async function recordingWordTiming(bookId: string): Promise<Map<string, boolean>> {
  const rows = await db.select({ id: chapters.id, status: chapters.status, audioPath: chapters.audioPath }).from(chapters).where(eq(chapters.bookId, bookId));
  const entries = await Promise.all(rows
    .filter((r) => r.status === "done" && r.audioPath !== null)
    .map(async (r) => [r.id, (await recordingStatus(r.audioPath)).words] as const));
  return new Map(entries);
}

const METERED = [{ prefix: "cartesia:", engine: "Cartesia", unit: "about one credit per character" }, { prefix: "elevenlabs:", engine: "ElevenLabs", unit: "one character each against the monthly quota" }];

// The characters a metered voice will bill for a synthesize_book call, or null for a local voice.
// Cartesia cannot report a balance to an ordinary key, so this is the only number an agent can
// weigh against the plan before it spends.
async function meteredEstimate(bookId: string, key: string | undefined, chapterIds: string[] | undefined, voice: string | undefined) {
  const [book] = await db.select({ voice: books.voice, variantVoices: books.variantVoices }).from(books).where(eq(books.id, bookId));
  if (!book) throw new Error("Book not found");
  const resolved = voice ?? (key !== undefined ? book.variantVoices?.[key]?.voice : undefined) ?? book.voice;
  const meter = METERED.find((m) => resolved.startsWith(m.prefix));
  if (!meter) return null;
  const scope = and(eq(chapters.bookId, bookId), chapterIds ? inArray(chapters.id, chapterIds) : eq(chapters.selected, true));
  let characters = 0;
  if (key !== undefined) {
    const rows = await db.select({ text: chapterVariants.text }).from(chapterVariants).innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
      .where(and(scope, eq(chapterVariants.key, key), eq(chapterVariants.status, "done")));
    characters = rows.reduce((n, r) => n + r.text.length, 0);
  } else {
    const rows = await db.select({ customText: chapters.customText, cleanText: chapters.cleanText, rawText: chapters.rawText }).from(chapters).where(scope);
    characters = rows.reduce((n, r) => n + chapterText(r).length, 0);
  }
  return { voice: resolved, engine: meter.engine, characters, billing: `${meter.engine} bills ${meter.unit}` };
}
