import { z } from "zod";
import { modelKeySchema } from "../lib/llm.ts";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { books, bookFiles, chapters, bookLogs, assemblies, documents, chapterVariants, folders, DEFAULT_PROFILE_ID } from "../schema.ts";
import type { Book, Chapter } from "../schema.ts";
import { eq, desc, asc, gt, and, ne, inArray, ilike, sql } from "drizzle-orm";
import { uploadsDir, bookOutputDir } from "../lib/paths.ts";
import { deleteBook } from "../lib/delete-book.ts";
import { folderAncestors } from "../lib/folders.ts";
import { appendLog } from "../lib/log.ts";
import { parseTtsVoice } from "../lib/tts.ts";
import { collectBlocksFromMarkerOutput, sliceChaptersAtIndices, type ExtractedChapter } from "../lib/marker.ts";
import { listMarkerSources } from "../lib/marker-sources.ts";
import { abortExtract } from "../lib/extract-registry.ts";
import { measureBookDiskUsage, measureDirs, removeDirs, bookTotalSizeCached } from "../lib/disk-usage.ts";
import { chapterChunkPreviewDir } from "../lib/chunk-previews.ts";
import { translationChunkPreviewDir } from "../workers/synthesize-translation.ts";
import { insertSuspendedChapters, resetChaptersKeepingInserted } from "../lib/insert-chapters.ts";
import { countAsciiNonAscii } from "../lib/token-estimate.ts";
import { assembleJobKey, documentJobKey, inFlightInputs } from "../lib/output-readiness.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, unlink, rm } from "node:fs/promises";
import { quickAddJob } from "graphile-worker";
import { env } from "../env.ts";

const connectionString = env.DATABASE_URL;

const NOTE_JOB_STALE_MS = 15 * 60_000;

function noteJobRunning(noteJob: Book["noteJob"]): boolean {
  if (!noteJob) return false;
  if (noteJob.status !== "queued" && noteJob.status !== "running") return false;
  return Date.now() - new Date(noteJob.updatedAt).getTime() < NOTE_JOB_STALE_MS;
}

function digestJobRunning(digestJob: Book["digestJob"]): boolean {
  if (digestJob?.status !== "running") return false;
  return Date.now() - new Date(digestJob.updatedAt).getTime() < NOTE_JOB_STALE_MS;
}

// Procedures that mutate a book answer with its fresh row; the row is known to exist
// because every one of them looked it up before touching it.
async function reloadBook(id: string): Promise<Book> {
  const [book] = await db.select().from(books).where(eq(books.id, id));
  if (!book) throw new Error("Book not found");
  return book;
}

// Assemble jobs have no per-row DB state; the queue is the only signal that one is
// pending but not yet running (books.status only flips once the worker picks it up).
async function hasQueuedAssembleJob(bookId: string): Promise<boolean> {
  const [probe] = (await db.execute(
    sql`SELECT to_regclass('graphile_worker._private_jobs') AS jobs_table`,
  )) as unknown as Array<{ jobs_table: string | null }>;
  if (!probe?.jobs_table) return false;

  const rows = (await db.execute(sql`
    SELECT 1
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    WHERE t.identifier IN ('assemble', 'assembleDocument') AND j.payload->>'bookId' = ${bookId}
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

function computeBookStatus(
  book: Book,
  chapterList: Pick<Chapter, "status">[],
): string {
  if (book.status === "extracting" || book.status === "assembling") return book.status;
  if (chapterList.length === 0) {
    if (book.status === "failed") return "failed";
    return book.status;
  }
  const statuses = chapterList.map((c) => c.status);
  if (statuses.some((s) => s === "synthesizing" || s === "normalizing")) return "synthesizing";
  if (statuses.some((s) => s === "pending")) return "synthesizing";
  if (statuses.every((s) => s === "done")) return "done";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.every((s) => s === "suspended" || s === "done")) return "suspended";
  return book.status;
}

// Chunk WAVs only matter for resuming a partial synthesis — finished chapters never reread them
async function cleanableChunkDirs(bookId: string): Promise<string[]> {
  const doneChapters = await db
    .select({ index: chapters.index })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.status, "done")));

  const doneTranslations = await db
    .select({ language: chapterVariants.key, index: chapters.index })
    .from(chapterVariants)
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(and(eq(chapters.bookId, bookId), eq(chapterVariants.audioStatus, "done")));

  return [
    ...doneChapters.map((c) => chapterChunkPreviewDir(bookId, c.index)),
    ...doneTranslations.map((t) => translationChunkPreviewDir(bookId, t.language, t.index)),
  ];
}

export const booksRouter = router({
  list: publicProcedure
    .input(z.object({ folderId: z.string().uuid().nullable().default(null) }).optional())
    .query(async ({ input, ctx }) => {
    const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
    const folderId = input?.folderId ?? null;
    // Books stay folder-unscoped (subtree rollups need them all); aggregates stay fully
    // unscoped — they join in memory by book id, so other profiles' rows are inert
    const allBooks = await db
      .select()
      .from(books)
      .where(eq(books.profileId, profileId))
      .orderBy(desc(books.createdAt));

    const chapterAgg = (await db.execute(sql`
      SELECT book_id, status, count(*)::int AS count FROM chapters GROUP BY book_id, status
    `)) as unknown as Array<{ book_id: string; status: string; count: number }>;

    const cleanupAgg = (await db.execute(sql`
      SELECT book_id, cleanup->>'status' AS status, count(*)::int AS count
      FROM chapters WHERE cleanup IS NOT NULL GROUP BY book_id, cleanup->>'status'
    `)) as unknown as Array<{ book_id: string; status: string; count: number }>;

    const fileAgg = (await db.execute(sql`
      SELECT book_id, status, count(*)::int AS count,
        count(*) FILTER (WHERE status = 'failed' AND error NOT LIKE 'Cancelled%')::int AS hard_failed,
        count(*) FILTER (WHERE raw_text IS NOT NULL)::int AS with_raw_text
      FROM book_files GROUP BY book_id, status
    `)) as unknown as Array<{ book_id: string; status: string; count: number; hard_failed: number; with_raw_text: number }>;

    const translationAgg = (await db.execute(sql`
      SELECT c.book_id, ct.language,
        min(ct.label) AS label,
        count(*) FILTER (WHERE ct.status = 'done')::int AS done,
        count(*) FILTER (WHERE ct.status IN ('translating', 'pending'))::int AS running,
        count(*) FILTER (WHERE ct.status = 'failed')::int AS failed,
        count(*) FILTER (WHERE ct.audio_status = 'synthesizing')::int AS audio_running
      FROM chapter_translations ct JOIN chapters c ON c.id = ct.chapter_id
      GROUP BY c.book_id, ct.language ORDER BY ct.language
    `)) as unknown as Array<{ book_id: string; language: string; label: string | null; done: number; running: number; failed: number; audio_running: number }>;

    const assemblyAgg = (await db.execute(sql`
      SELECT book_id, count(*)::int AS count FROM assemblies GROUP BY book_id
    `)) as unknown as Array<{ book_id: string; count: number }>;

    const documentAgg = (await db.execute(sql`
      SELECT book_id, format, count(*)::int AS count FROM documents GROUP BY book_id, format
    `)) as unknown as Array<{ book_id: string; format: "pdf" | "epub"; count: number }>;

    const lastLogAgg = (await db.execute(sql`
      SELECT book_id, max(created_at) AS last FROM book_logs GROUP BY book_id
    `)) as unknown as Array<{ book_id: string; last: string }>;

    const byBook = <T extends { book_id: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        const list = map.get(row.book_id) ?? [];
        list.push(row);
        map.set(row.book_id, list);
      }
      return map;
    };
    const chaptersBy = byBook(chapterAgg);
    const cleanupBy = byBook(cleanupAgg);
    const filesBy = byBook(fileAgg);
    const translationsBy = byBook(translationAgg);
    const assembliesBy = byBook(assemblyAgg);
    const documentsBy = byBook(documentAgg);
    const lastLogBy = new Map(lastLogAgg.map((r) => [r.book_id, r.last]));

    const deriveBookStats = (book: Book) => {
      const chapterCounts = chaptersBy.get(book.id) ?? [];
      const countOf = (rows: { status: string; count: number }[], ...statuses: string[]) =>
        rows.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r.count, 0);

      const chapterCount = chapterCounts.reduce((sum, r) => sum + r.count, 0);
      const chaptersWithAudio = countOf(chapterCounts, "done");
      const translations = translationsBy.get(book.id) ?? [];
      const fileRows = filesBy.get(book.id) ?? [];
      const cleanupRows = cleanupBy.get(book.id) ?? [];
      const documentRows = documentsBy.get(book.id) ?? [];

      const activity = {
        extracting: countOf(fileRows, "extracting", "pending") > 0 || book.status === "extracting",
        synthesizing:
          countOf(chapterCounts, "pending", "normalizing", "synthesizing") +
          translations.reduce((sum, t) => sum + t.audio_running, 0),
        translating: translations.reduce((sum, t) => sum + t.running, 0),
        cleaning: countOf(cleanupRows, "pending", "cleaning"),
        assembling: book.status === "assembling",
        aiNote: noteJobRunning(book.noteJob),
        digest: digestJobRunning(book.digestJob),
      };
      const failures = {
        files: fileRows.reduce((sum, r) => sum + r.hard_failed, 0),
        chapters: countOf(chapterCounts, "failed"),
        translations: translations.reduce((sum, t) => sum + t.failed, 0),
        cleanup: countOf(cleanupRows, "failed"),
      };

      const lastLog = lastLogBy.get(book.id);
      const lastActivityAt = new Date(
        Math.max(new Date(book.updatedAt).getTime(), lastLog ? new Date(lastLog).getTime() : 0),
      );

      return {
        chapterCount,
        chaptersWithAudio,
        // Mirrors the createDigest/textAvailability guard
        hasText: chapterCount > 0 || fileRows.reduce((sum, r) => sum + r.with_raw_text, 0) > 0,
        activity,
        failures,
        // Cancellations are deliberate — only real failures get the red badge (mirrors hard_failed)
        failed: book.status === "failed" && !(book.error ?? "").startsWith("Cancelled"),
        languages: translations.map((t) => ({ language: t.language, label: t.label, done: t.done })),
        outputs: {
          assemblies: assembliesBy.get(book.id)?.[0]?.count ?? 0,
          pdfs: documentRows.find((d) => d.format === "pdf")?.count ?? 0,
          epubs: documentRows.find((d) => d.format === "epub")?.count ?? 0,
        },
        lastActivityAt,
      };
    };
    const isActive = (a: ReturnType<typeof deriveBookStats>["activity"]) =>
      a.extracting || a.synthesizing > 0 || a.translating > 0 || a.cleaning > 0 || a.assembling || a.aiNote || a.digest;

    const overview = await Promise.all(
      allBooks
        .filter((book) => (book.folderId ?? null) === folderId)
        .map(async (book) => ({
          id: book.id,
          title: book.title,
          kind: book.kind,
          createdAt: book.createdAt,
          skipSynthesis: book.skipSynthesis,
          error: book.status === "failed" ? book.error : null,
          searchIndex: book.searchIndex,
          ...deriveBookStats(book),
          sizeBytes: await bookTotalSizeCached(book.id),
        })),
    );

    const allFolders = await db
      .select()
      .from(folders)
      .where(eq(folders.profileId, profileId))
      .orderBy(asc(folders.name));
    const childrenOf = new Map<string | null, typeof allFolders>();
    for (const f of allFolders) {
      const key = f.parentId ?? null;
      childrenOf.set(key, [...(childrenOf.get(key) ?? []), f]);
    }
    const folderRows = await Promise.all(
      (childrenOf.get(folderId) ?? []).map(async (folder) => {
        const subtree = new Set<string>();
        const stack = [folder.id];
        while (stack.length) {
          const id = stack.pop()!;
          subtree.add(id);
          for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
        }
        const descendantBooks = allBooks.filter((b) => b.folderId && subtree.has(b.folderId));
        const stats = descendantBooks.map((b) => deriveBookStats(b));
        const failedCount = stats.filter(
          ({ failed, failures: f }) => failed || f.files + f.chapters + f.translations + f.cleanup > 0,
        ).length;
        const sizes = await Promise.all(descendantBooks.map((b) => bookTotalSizeCached(b.id)));
        return {
          id: folder.id,
          name: folder.name,
          createdAt: folder.createdAt,
          bookCount: descendantBooks.length,
          activeBookCount: stats.filter((s) => isActive(s.activity)).length,
          failedBookCount: failedCount,
          sizeBytes: sizes.reduce((sum, n) => sum + n, 0),
          lastActivityAt: stats.length
            ? new Date(Math.max(...stats.map((s) => s.lastActivityAt.getTime())))
            : null,
        };
      }),
    );

    return {
      folders: folderRows,
      books: overview.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()),
    };
  }),

  // Mirrors createDigest's per-book guard so the modal can warn before submitting
  textAvailability: publicProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }))
    .query(async ({ input }) => {
      const withChapters = await db
        .selectDistinct({ bookId: chapters.bookId })
        .from(chapters)
        .where(inArray(chapters.bookId, input.ids));
      const withRawText = await db
        .selectDistinct({ bookId: bookFiles.bookId })
        .from(bookFiles)
        .where(and(inArray(bookFiles.bookId, input.ids), sql`${bookFiles.rawText} is not null`));
      const hasText = new Set([...withChapters, ...withRawText].map((r) => r.bookId));
      return input.ids.map((id) => ({ id, hasText: hasText.has(id) }));
    }),

  search: publicProcedure
    .input(z.object({ query: z.string().trim().min(1).max(200) }))
    .query(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const words = input.query.split(/\s+/).filter(Boolean).slice(0, 8);
      const pattern = (w: string) => `%${w.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await db
        .select({ id: books.id, title: books.title, kind: books.kind, folderId: books.folderId, createdAt: books.createdAt })
        .from(books)
        .where(and(eq(books.profileId, profileId), ...words.map((w) => ilike(books.title, pattern(w)))))
        .orderBy(desc(books.createdAt))
        .limit(50);

      const allFolders = await db
        .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.profileId, profileId));
      const folderById = new Map(allFolders.map((f) => [f.id, f]));
      const pathFor = (id: string) => {
        const path: { id: string; name: string }[] = [];
        let cur = folderById.get(id);
        while (cur && path.length < 20) {
          path.unshift({ id: cur.id, name: cur.name });
          cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
        }
        return path;
      };

      return rows.map((b) => ({ ...b, folderPath: b.folderId ? pathFor(b.folderId) : [] }));
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");

      const allChapters = await db
        .select()
        .from(chapters)
        .where(eq(chapters.bookId, input.id))
        .orderBy(asc(chapters.index));

      const chaptersWithStats = allChapters.map((ch) => {
        const text = ch.customText ?? ch.cleanText ?? ch.rawText;
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const hasCleanText = !!ch.cleanText;
        const hasCustomText = !!ch.customText;
        const hasSourceBlocks = Array.isArray(ch.sourceBlocks);
        return { ...ch, wordCount, hasCleanText, hasCustomText, hasSourceBlocks, rawText: undefined, cleanText: undefined, customText: undefined, sourceBlocks: undefined };
      });

      const totalWords = chaptersWithStats.reduce((sum, ch) => sum + ch.wordCount, 0);
      const totalDurationMs = allChapters.reduce((sum, ch) => sum + (ch.durationMs ?? 0), 0);
      const status = computeBookStatus(book, allChapters);

      // rawText can be megabytes and this query is polled — never ship it
      const files = await db
        .select({
          id: bookFiles.id,
          bookId: bookFiles.bookId,
          index: bookFiles.index,
          filename: bookFiles.filename,
          pdfPath: bookFiles.pdfPath,
          status: bookFiles.status,
          selected: bookFiles.selected,
          skipSynthesis: bookFiles.skipSynthesis,
          rawWords: bookFiles.rawWords,
          hasRawText: sql<boolean>`${bookFiles.rawText} is not null`,
          error: bookFiles.error,
          createdAt: bookFiles.createdAt,
        })
        .from(bookFiles)
        .where(eq(bookFiles.bookId, input.id))
        .orderBy(asc(bookFiles.index));

      const rawTextTotalWords = files.reduce((sum, f) => sum + (f.rawWords ?? 0), 0);
      const assembleQueued = await hasQueuedAssembleJob(input.id);
      const folderPath = book.folderId ? await folderAncestors(book.folderId) : [];

      return { ...book, status, chapters: chaptersWithStats, totalWords, totalDurationMs, files, rawTextTotalWords, assembleQueued, folderPath };
    }),

  logs: publicProcedure
    .input(z.object({
      bookId: z.string().uuid(),
      after: z.string().datetime().optional(),
    }))
    .query(async ({ input }) => {
      const where = input.after
        ? and(eq(bookLogs.bookId, input.bookId), gt(bookLogs.createdAt, new Date(input.after)))
        : eq(bookLogs.bookId, input.bookId);

      return db
        .select({ id: bookLogs.id, message: bookLogs.message, fileIndex: bookLogs.fileIndex, createdAt: bookLogs.createdAt })
        .from(bookLogs)
        .where(where)
        .orderBy(asc(bookLogs.createdAt));
    }),

  clearLogs: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await db.delete(bookLogs).where(eq(bookLogs.bookId, input.bookId));
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string().uuid(), title: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await db.update(books).set({ title: input.title, updatedAt: new Date() }).where(eq(books.id, input.id));
      return { success: true };
    }),

  updateSettings: publicProcedure
    .input(z.object({
      id: z.string().uuid(),
      voice: z.string().optional(),
      speed: z.number().min(0.5).max(2.0).optional(),
      forceOcr: z.boolean().optional(),
      llmChapterDetection: z.boolean().optional(),
      chapterModel: modelKeySchema.optional(),
      // ISO-639-1 of the book's own text; "" clears it back to unknown
      language: z.string().max(8).nullable().optional(),
      // "" clears it, so a wrong guess from the PDF can be taken back rather than only corrected
      author: z.string().max(200).nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.voice !== undefined) {
        parseTtsVoice(input.voice);
        updates.voice = input.voice;
      }
      if (input.speed !== undefined) updates.speed = input.speed;
      if (input.forceOcr !== undefined) updates.forceOcr = input.forceOcr;
      if (input.llmChapterDetection !== undefined) updates.llmChapterDetection = input.llmChapterDetection;
      if (input.chapterModel !== undefined) updates.chapterModel = input.chapterModel;
      if (input.language !== undefined) updates.language = input.language || null;
      if (input.author !== undefined) updates.author = input.author?.trim() || null;
      await db.update(books).set(updates).where(eq(books.id, input.id));
      return { success: true };
    }),

  // Written just before an extraction runs; extract.ts reads it to decide whether new chapters are
  // born "pending" (and queued for synthesis) or "suspended".
  setAutoSynthesize: publicProcedure
    .input(z.object({ id: z.string().uuid(), autoSynthesize: z.boolean() }))
    .mutation(async ({ input }) => {
      const skipSynthesis = !input.autoSynthesize;
      await db.update(books).set({ skipSynthesis, updatedAt: new Date() }).where(eq(books.id, input.id));
      await db.update(bookFiles).set({ skipSynthesis }).where(eq(bookFiles.bookId, input.id));
      return { success: true };
    }),

  upload: publicProcedure
    .input(
      z.object({
        title: z.string().min(1),
        filename: z.string().min(1),
        voice: z.string().default("kokoro:af_heart"),
        speed: z.number().min(0.5).max(2.0).default(1.0),
        skipSynthesis: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      parseTtsVoice(input.voice);

      const id = randomUUID();
      const pdfDir = path.join(uploadsDir, id);
      await mkdir(pdfDir, { recursive: true });
      const pdfPath = path.join(pdfDir, input.filename);

      const [book] = await db
        .insert(books)
        .values({
          id,
          title: input.title,
          filename: input.filename,
          pdfPath,
          voice: input.voice,
          speed: input.speed,
          skipSynthesis: input.skipSynthesis,
          profileId: ctx.profileId ?? DEFAULT_PROFILE_ID,
        })
        .returning();

      await quickAddJob({ connectionString }, "extract", { bookId: id }, { maxAttempts: 1 });

      return book;
    }),

  retry: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        voice: z.string().optional(),
        speed: z.number().min(0.5).max(2.0).optional(),
        forceOcr: z.boolean().optional(),
        llmChapterDetection: z.boolean().optional(),
        chapterModel: modelKeySchema.optional(),
      })
    )
    .mutation(async ({ input }) => {
      const [existing] = await db.select().from(books).where(eq(books.id, input.id));
      if (!existing) throw new Error("Book not found");
      if (existing.kind !== "pdf") throw new Error("Synthetic books have no PDF to re-extract");

      const updates: Record<string, unknown> = {
        status: "pending",
        error: null,
        outputPath: null,
        updatedAt: new Date(),
      };
      if (input.voice) {
        parseTtsVoice(input.voice);
        updates.voice = input.voice;
      }
      if (input.speed) updates.speed = input.speed;
      if (input.forceOcr !== undefined) updates.forceOcr = input.forceOcr;
      if (input.llmChapterDetection !== undefined) updates.llmChapterDetection = input.llmChapterDetection;
      if (input.chapterModel !== undefined) updates.chapterModel = input.chapterModel;

      await db.update(books).set(updates).where(eq(books.id, input.id));
      await rm(bookOutputDir(input.id), { recursive: true, force: true }).catch(() => {});
      const keptCount = await resetChaptersKeepingInserted(input.id);
      await db.delete(assemblies).where(eq(assemblies.bookId, input.id));
      await db.update(bookFiles).set({ status: "pending", error: null }).where(eq(bookFiles.bookId, input.id));
      await db.delete(bookLogs).where(eq(bookLogs.bookId, input.id));
      await appendLog(input.id, "Re-extracting from scratch");
      if (keptCount > 0) {
        await appendLog(input.id, `Kept ${keptCount} inserted chapter${keptCount === 1 ? "" : "s"} (moved to the front, audio reset)`);
      }

      await quickAddJob({ connectionString }, "extract", { bookId: input.id }, { maxAttempts: 1 });

      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      return book;
    }),

  createDigest: publicProcedure
    .input(z.object({
      title: z.string().trim().min(1),
      sourceBookIds: z.array(z.string().uuid()).min(2).max(200),
      prompt: z.string().min(1).max(4000),
      model: modelKeySchema.default("flash"),
      folderId: z.string().uuid().nullable().default(null),
    }))
    .mutation(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      if (input.folderId) {
        const [folder] = await db
          .select({ id: folders.id })
          .from(folders)
          .where(and(eq(folders.id, input.folderId), eq(folders.profileId, profileId)));
        if (!folder) throw new Error("Folder not found");
      }
      const sources = await db
        .select({ id: books.id, title: books.title })
        .from(books)
        .where(inArray(books.id, input.sourceBookIds));
      const foundIds = new Set(sources.map((s) => s.id));
      const missing = input.sourceBookIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) throw new Error(`${missing.length} selected book(s) no longer exist`);

      const unusable: string[] = [];
      for (const id of input.sourceBookIds) {
        const [chapter] = await db.select({ id: chapters.id }).from(chapters).where(eq(chapters.bookId, id)).limit(1);
        if (chapter) continue;
        const [file] = await db
          .select({ id: bookFiles.id })
          .from(bookFiles)
          .where(and(eq(bookFiles.bookId, id), sql`${bookFiles.rawText} is not null`))
          .limit(1);
        if (!file) unusable.push(sources.find((s) => s.id === id)!.title);
      }
      if (unusable.length > 0) {
        throw new Error(`No text available for: ${unusable.map((t) => `"${t}"`).join(", ")} — extract them (with Force OCR if scanned) first`);
      }

      const now = new Date().toISOString();
      const [digestBook] = await db
        .insert(books)
        .values({
          title: input.title,
          kind: "digest",
          skipSynthesis: true,
          origin: { type: "digest", sourceBookIds: input.sourceBookIds, prompt: input.prompt, model: input.model },
          digestJob: { status: "running", createdAt: now, updatedAt: now },
          folderId: input.folderId,
          profileId,
        })
        .returning();

      if (!digestBook) throw new Error("Failed to create the digest book");
      await appendLog(digestBook.id, `Creating digest from ${input.sourceBookIds.length} books`);
      await quickAddJob({ connectionString }, "digest", { bookId: digestBook.id }, { maxAttempts: 1 });

      return digestBook;
    }),

  resumeDigest: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");
      if (book.origin?.type !== "digest") throw new Error("Not a digest book");

      const runningSince = book.digestJob?.status === "running" ? new Date(book.digestJob.updatedAt).getTime() : null;
      if (runningSince && Date.now() - runningSince < 15 * 60_000) {
        throw new Error("The digest is already running");
      }

      const now = new Date().toISOString();
      await db
        .update(books)
        .set({
          digestJob: { status: "running", createdAt: book.digestJob?.createdAt ?? now, updatedAt: now },
          updatedAt: new Date(),
        })
        .where(eq(books.id, input.id));
      await appendLog(input.id, "Resuming digest — already-summarized books are skipped");
      await quickAddJob({ connectionString }, "digest", { bookId: input.id }, { maxAttempts: 1 });

      return reloadBook(input.id);
    }),

  rawTextStats: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      const files = await db
        .select({ rawText: bookFiles.rawText })
        .from(bookFiles)
        .where(eq(bookFiles.bookId, input.bookId));
      let ascii = 0;
      let nonAscii = 0;
      let missingFiles = 0;
      for (const f of files) {
        if (!f.rawText) {
          missingFiles++;
          continue;
        }
        const counts = countAsciiNonAscii(f.rawText);
        ascii += counts.ascii;
        nonAscii += counts.nonAscii;
      }
      return { ascii, nonAscii, fileCount: files.length - missingFiles, missingFiles };
    }),

  extractChapters: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");
      if (book.kind !== "pdf") throw new Error("Synthetic books have no PDF to extract");
      if (book.status === "extracting" || book.status === "assembling") {
        throw new Error("Cannot extract chapters while book is processing");
      }

      const flipped = await db
        .update(bookFiles)
        .set({ status: "pending" })
        .where(and(eq(bookFiles.bookId, input.id), eq(bookFiles.status, "raw")))
        .returning({ id: bookFiles.id });

      if (flipped.length === 0) {
        const pending = await db
          .select({ id: bookFiles.id })
          .from(bookFiles)
          .where(and(eq(bookFiles.bookId, input.id), eq(bookFiles.status, "pending")));
        if (pending.length === 0) throw new Error("All files already extracted");
      }

      await db.update(books).set({ status: "pending", error: null, updatedAt: new Date() }).where(eq(books.id, input.id));
      await appendLog(input.id, "Queued chapter extraction");
      await quickAddJob({ connectionString }, "extract", { bookId: input.id }, { maxAttempts: 1 });

      return reloadBook(input.id);
    }),

  redetectChapters: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        forceOcr: z.boolean().optional(),
        llmChapterDetection: z.boolean().optional(),
        chapterModel: modelKeySchema.optional(),
      })
    )
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");
      if (book.kind !== "pdf") throw new Error("Cannot re-detect chapters on a synthetic book");
      if (book.status === "extracting" || book.status === "assembling") {
        throw new Error("Cannot re-detect chapters while book is processing");
      }

      // "extracting" immediately so the UI starts polling and double-enqueue is blocked
      const updates: Record<string, unknown> = {
        status: "extracting",
        error: null,
        outputPath: null,
        updatedAt: new Date(),
      };
      if (input.forceOcr !== undefined) updates.forceOcr = input.forceOcr;
      if (input.llmChapterDetection !== undefined) updates.llmChapterDetection = input.llmChapterDetection;
      if (input.chapterModel !== undefined) updates.chapterModel = input.chapterModel;
      await db.update(books).set(updates).where(eq(books.id, input.id));

      await appendLog(input.id, "Queued chapter re-detection");
      await quickAddJob({ connectionString }, "redetect", { bookId: input.id }, { maxAttempts: 1 });

      return reloadBook(input.id);
    }),

  structure: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");

      const bookChapters = await db
        .select({ title: chapters.title, pageStart: chapters.pageStart, sourceFileIndex: chapters.sourceFileIndex })
        .from(chapters)
        .where(eq(chapters.bookId, input.id));

      const sources = await listMarkerSources(book);
      const files = [];

      for (const source of sources) {
        let allBlocks;
        try {
          allBlocks = await collectBlocksFromMarkerOutput(source.outDir);
        } catch {
          files.push({ fileIndex: source.fileIndex, filename: source.filename, missing: true, totalWords: 0, totalPages: 0, headings: [] });
          continue;
        }

        const currentStarts = new Set(
          bookChapters
            .filter((c) => c.sourceFileIndex === source.fileIndex)
            .map((c) => `${c.pageStart}|${c.title}`)
        );

        const headings = [];
        let cumWords = 0;
        for (const [i, b] of allBlocks.entries()) {
          if (b.included && b.type === "SectionHeader") {
            headings.push({
              blockIndex: i,
              page: b.page,
              level: b.level ?? null,
              text: b.text,
              wordsBefore: cumWords,
              isChapterStart: currentStarts.has(`${b.page}|${b.text}`),
            });
          }
          if (b.included) cumWords += b.text.split(/\s+/).filter(Boolean).length;
        }

        files.push({
          fileIndex: source.fileIndex,
          filename: source.filename,
          missing: false,
          totalWords: cumWords,
          totalPages: allBlocks.length > 0 ? Math.max(...allBlocks.map((b) => b.page)) : 0,
          headings,
        });
      }

      return { files };
    }),

  proposeChapters: publicProcedure
    .input(z.object({ id: z.string().uuid(), method: z.enum(["llm", "deterministic"]), model: modelKeySchema.optional() }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");
      if (book.kind !== "pdf") throw new Error("Synthetic books have no PDF structure");

      // Stale-running escape hatch in case a propose job died without writing back
      const runningSince = book.chapterProposal?.status === "running" ? new Date(book.chapterProposal.createdAt).getTime() : null;
      if (runningSince && Date.now() - runningSince < 15 * 60_000) {
        throw new Error("A chapter proposal is already running");
      }

      await db
        .update(books)
        .set({
          chapterProposal: { status: "running", method: input.method, createdAt: new Date().toISOString() },
          ...(input.model !== undefined ? { chapterModel: input.model } : {}),
          updatedAt: new Date(),
        })
        .where(eq(books.id, input.id));

      await appendLog(input.id, `Queued ${input.method === "llm" ? "LLM" : "deterministic"} chapter proposal`);
      await quickAddJob({ connectionString }, "propose", { bookId: input.id, method: input.method }, { maxAttempts: 1 });

      return reloadBook(input.id);
    }),

  applyChapterBoundaries: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        boundaries: z
          .array(
            z.object({
              fileIndex: z.number().int().nullable(),
              blockIndex: z.number().int().nonnegative(),
              title: z.string().trim().min(1).optional(),
            })
          )
          .min(1),
      })
    )
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");
      if (book.kind !== "pdf") throw new Error("Synthetic books have no PDF structure");
      if (book.status === "extracting" || book.status === "assembling") {
        throw new Error("Cannot apply chapter boundaries while book is processing");
      }

      const sources = await listMarkerSources(book);
      const knownFiles = new Set(sources.map((s) => s.fileIndex));
      for (const b of input.boundaries) {
        if (!knownFiles.has(b.fileIndex)) throw new Error(`Unknown file index ${b.fileIndex}`);
      }

      // Slice everything before deleting so a bad boundary can't destroy existing chapters
      const perFile: { fileIndex: number | null; sliced: ExtractedChapter[] }[] = [];
      for (const source of sources) {
        const fileBoundaries = input.boundaries.filter((b) => b.fileIndex === source.fileIndex);
        const indices = fileBoundaries.map((b) => b.blockIndex);
        const titles = new Map(fileBoundaries.filter((b) => b.title).map((b) => [b.blockIndex, b.title!]));
        const allBlocks = await collectBlocksFromMarkerOutput(source.outDir);
        for (const i of indices) {
          if (i >= allBlocks.length) throw new Error(`Block index ${i} out of range for "${source.filename}"`);
        }
        perFile.push({ fileIndex: source.fileIndex, sliced: sliceChaptersAtIndices(allBlocks, indices, titles) });
      }

      const oldChapters = await db
        .select({ audioPath: chapters.audioPath })
        .from(chapters)
        .where(eq(chapters.bookId, input.id));
      const deletedAudioFiles = oldChapters.filter((ch) => ch.audioPath).length;

      await rm(bookOutputDir(input.id), { recursive: true, force: true }).catch(() => {});
      await db.delete(assemblies).where(eq(assemblies.bookId, input.id));
      const keptCount = await resetChaptersKeepingInserted(input.id);

      await appendLog(input.id, `Applying ${input.boundaries.length} manual chapter boundaries`);
      if (oldChapters.length > 0) {
        await appendLog(
          input.id,
          `Removed ${oldChapters.length - keptCount} existing chapter${oldChapters.length - keptCount === 1 ? "" : "s"} and ${deletedAudioFiles} chapter audio file${deletedAudioFiles === 1 ? "" : "s"}`
        );
      }
      if (keptCount > 0) {
        await appendLog(input.id, `Kept ${keptCount} inserted chapter${keptCount === 1 ? "" : "s"} (moved to the front, audio reset)`);
      }

      let chapterOffset = keptCount;
      for (const { fileIndex, sliced } of perFile) {
        await insertSuspendedChapters(input.id, sliced, chapterOffset, fileIndex);
        chapterOffset += sliced.length;
      }

      await db
        .update(books)
        .set({
          totalChapters: chapterOffset,
          chapterDetection: "manual",
          chapterProposal: null,
          status: "pending",
          error: null,
          outputPath: null,
          updatedAt: new Date(),
        })
        .where(eq(books.id, input.id));

      await appendLog(input.id, `Applied chapter boundaries: ${chapterOffset} chapters — chapters are suspended. Queue selected chapters when ready.`);

      return reloadBook(input.id);
    }),

  processSelected: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");

      const selectedChapters = await db
        .select()
        .from(chapters)
        .where(and(eq(chapters.bookId, input.id), eq(chapters.selected, true)))
        .orderBy(asc(chapters.index));

      const processable = selectedChapters.filter(
        (ch) => ch.status === "failed" || ch.status === "suspended" || ch.status === "pending" || ch.status === "done"
      );

      if (processable.length === 0) {
        throw new Error("No selected chapters are ready for synthesis");
      }

      await db.delete(bookLogs).where(eq(bookLogs.bookId, input.id));

      let queued = 0;
      let resynthesized = 0;
      for (const ch of processable) {
        if (ch.status === "done") {
          resynthesized++;
        }

        if (ch.cleanText) {
          await db
            .update(chapters)
            .set({ status: "pending", error: null, audioPath: null, durationMs: null, progress: null, synthesizedWith: null })
            .where(eq(chapters.id, ch.id));
          await quickAddJob({ connectionString }, "synthesize", { chapterId: ch.id, bookId: input.id }, { maxAttempts: 1 });
          queued++;
        } else {
          await db
            .update(chapters)
            .set({ status: "pending", error: null, audioPath: null, durationMs: null, progress: null, synthesizedWith: null })
            .where(eq(chapters.id, ch.id));
          await quickAddJob({ connectionString }, "normalize", { chapterId: ch.id, bookId: input.id }, { maxAttempts: 1 });
          queued++;
        }
      }

      await appendLog(
        input.id,
        `Queued ${queued} selected chapter${queued !== 1 ? "s" : ""} for synthesis with ${book.voice}${resynthesized > 0 ? ` (${resynthesized} re-synthesizing existing audio)` : ""}`
      );

      await db.update(books).set({ error: null, updatedAt: new Date() }).where(eq(books.id, input.id));

      return reloadBook(input.id);
    }),

  assemble: publicProcedure
    .input(z.object({ id: z.string().uuid(), waitForAll: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");

      const selectedDone = await db
        .select()
        .from(chapters)
        .where(and(
          eq(chapters.bookId, input.id),
          eq(chapters.selected, true),
          eq(chapters.status, "done"),
        ));

      const withAudio = selectedDone.filter((ch) => ch.audioPath);
      const waiting = input.waitForAll ? await inFlightInputs(input.id, null, "audio") : 0;
      if (withAudio.length === 0 && waiting === 0) {
        throw new Error("No selected chapters with audio available for assembly");
      }

      await db
        .update(books)
        .set({ outputPath: null, error: null, updatedAt: new Date() })
        .where(eq(books.id, input.id));

      await appendLog(input.id, waiting > 0
        ? `Queuing assembly once ${waiting} chapter${waiting !== 1 ? "s" : ""} finish${waiting === 1 ? "es" : ""} synthesizing`
        : `Queuing assembly (${withAudio.length} selected chapter${withAudio.length !== 1 ? "s" : ""} with audio)`);
      await quickAddJob(
        { connectionString },
        "assemble",
        { bookId: input.id, waitForAll: input.waitForAll },
        { maxAttempts: 1, jobKey: assembleJobKey(input.id), jobKeyMode: "replace" },
      );

      return reloadBook(input.id);
    }),

  // Lets the client show where "copy to import folder" would land; null = not configured
  exportConfig: publicProcedure.query(() => ({
    readaloudDropDir: env.READALOUD_DROP_DIR ?? null,
  })),

  exportDocument: publicProcedure
    .input(z.object({
      id: z.string().uuid(),
      language: z.string().min(1).optional(),
      format: z.enum(["pdf", "epub", "epub-sync"]),
      copyToDropDir: z.boolean().optional(),
      waitForAll: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.id));
      if (!book) throw new Error("Book not found");
      if (book.status === "assembling") throw new Error("Assembly already in progress");

      const waitingFor = input.waitForAll
        ? await inFlightInputs(input.id, input.language ?? null, input.format === "epub-sync" ? "audio" : "text")
        : 0;

      let exportable: number;
      if (input.format === "epub-sync") {
        // Needs finished audio, not just text
        if (input.language) {
          const rows = await db
            .select({ id: chapters.id })
            .from(chapterVariants)
            .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
            .where(and(
              eq(chapters.bookId, input.id),
              eq(chapters.selected, true),
              eq(chapterVariants.key, input.language),
              eq(chapterVariants.audioStatus, "done"),
            ));
          exportable = rows.length;
        } else {
          const rows = await db
            .select({ id: chapters.id })
            .from(chapters)
            .where(and(eq(chapters.bookId, input.id), eq(chapters.selected, true), eq(chapters.status, "done")));
          exportable = rows.length;
        }
        if (exportable === 0 && waitingFor === 0) {
          throw new Error(input.language
            ? `No selected chapters have finished ${input.language} audio`
            : "No selected chapters have finished audio");
        }
      } else if (input.language) {
        const rows = await db
          .select({ id: chapters.id })
          .from(chapterVariants)
          .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
          .where(and(
            eq(chapters.bookId, input.id),
            eq(chapters.selected, true),
            eq(chapterVariants.key, input.language),
            eq(chapterVariants.status, "done"),
          ));
        exportable = rows.length;
      } else {
        const rows = await db
          .select({ id: chapters.id })
          .from(chapters)
          .where(and(eq(chapters.bookId, input.id), eq(chapters.selected, true)));
        exportable = rows.length;
      }
      if (exportable === 0 && waitingFor === 0) {
        throw new Error(input.language
          ? `No selected chapters have a finished ${input.language} translation`
          : "No chapters selected");
      }

      const formatLabel = input.format === "epub-sync" ? "synced EPUB" : input.format.toUpperCase();
      const langLabel = input.language ? ` · ${input.language}` : "";
      await appendLog(input.id, waitingFor > 0
        ? `Queuing ${formatLabel} export once ${waitingFor} chapter${waitingFor !== 1 ? "s" : ""} finish${waitingFor === 1 ? "es" : ""}${langLabel}`
        : `Queuing ${formatLabel} export (${exportable} chapter${exportable !== 1 ? "s" : ""})${langLabel}`);
      // jobKey: repeat clicks replace the queued job instead of stacking duplicates
      await quickAddJob(
        { connectionString },
        "assembleDocument",
        {
          bookId: input.id,
          language: input.language,
          format: input.format,
          copyToDropDir: input.copyToDropDir,
          waitForAll: input.waitForAll,
        },
        { maxAttempts: 1, jobKey: documentJobKey(input.id, input.format, input.language), jobKeyMode: "replace" },
      );
      return { success: true };
    }),

  pendingDocumentExports: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      const rows = (await db.execute(sql`
        SELECT j.payload->>'format' AS format, j.payload->>'language' AS language,
               j.locked_at IS NOT NULL AS running, j.run_at > now() AS waiting,
               COALESCE((j.payload->>'copyToDropDir')::boolean, false) AS copy_to_drop_dir
        FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'assembleDocument' AND j.payload->>'bookId' = ${input.bookId}
      `)) as unknown as Array<{
        format: "pdf" | "epub" | "epub-sync";
        language: string | null;
        running: boolean;
        waiting: boolean;
        copy_to_drop_dir: boolean;
      }>;
      return rows.map(({ copy_to_drop_dir, ...row }) => ({ ...row, copyToDropDir: copy_to_drop_dir }));
    }),

  documents: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      return db
        .select()
        .from(documents)
        .where(eq(documents.bookId, input.bookId))
        .orderBy(desc(documents.createdAt));
    }),

  deleteDocument: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [document] = await db.select().from(documents).where(eq(documents.id, input.id));
      if (!document) throw new Error("Document not found");

      await unlink(document.outputPath).catch(() => {});
      await db.delete(documents).where(eq(documents.id, input.id));
      return { success: true };
    }),

  diskUsage: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      const asm = await db.select({ outputPath: assemblies.outputPath }).from(assemblies).where(eq(assemblies.bookId, input.bookId));
      const docs = await db.select({ outputPath: documents.outputPath }).from(documents).where(eq(documents.bookId, input.bookId));
      const usage = await measureBookDiskUsage(
        input.bookId,
        new Set(asm.map((a) => a.outputPath)),
        new Set(docs.map((d) => d.outputPath)),
      );
      const cleanableChunkWavs = await measureDirs(await cleanableChunkDirs(input.bookId));
      return { ...usage, cleanableChunkWavs };
    }),

  cleanupChunks: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const freed = await removeDirs(await cleanableChunkDirs(input.bookId));
      await appendLog(input.bookId, `Cleaned up WAV chunks of finished chapters — freed ${(freed / 1e9).toFixed(2)} GB`);
      return { freed };
    }),

  cancel: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await appendLog(input.id, "Extraction cancelled");

      // A deliberate stop is "suspended", not "failed" — chapters and variants already model it
      // that way, and a red error that never clears is the wrong resting state for a choice.
      await db
        .update(books)
        .set({ status: "suspended", error: null, updatedAt: new Date() })
        .where(eq(books.id, input.id));

      await db
        .update(chapters)
        .set({ status: "suspended", error: null })
        .where(and(
          eq(chapters.bookId, input.id),
          ne(chapters.status, "done"),
        ));

      const cancelledFiles = await db
        .update(bookFiles)
        .set({ status: "suspended", error: null })
        .where(and(
          eq(bookFiles.bookId, input.id),
          inArray(bookFiles.status, ["extracting", "pending"]),
        ))
        .returning({ id: bookFiles.id });
      let killedCount = 0;
      for (const f of cancelledFiles) {
        if (abortExtract(f.id)) killedCount++;
      }
      if (abortExtract(input.id)) killedCount++; // legacy single-file extraction is keyed by bookId
      if (cancelledFiles.length > 0) {
        await appendLog(input.id, `Cancelled extraction of ${cancelledFiles.length} file(s)${killedCount > 0 ? ` — stopped ${killedCount} running process(es)` : ""}`);
      }

      const cleared = (await db.execute(sql`
        DELETE FROM graphile_worker._private_jobs j
        USING graphile_worker._private_tasks t
        WHERE t.id = j.task_id AND t.identifier IN ('normalize', 'synthesize', 'extract')
          AND (j.payload ->> 'bookId') = ${input.id}
          AND j.locked_at IS NULL
        RETURNING j.id
      `)) as unknown as unknown[];

      const clearedCount = cleared.length;
      if (clearedCount > 0) {
        await appendLog(input.id, `Cleared ${clearedCount} queued job${clearedCount === 1 ? "" : "s"}`);
      }

      return { success: true };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await deleteBook(input.id);
      return { success: true };
    }),

  deleteMany: publicProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }))
    .mutation(async ({ input }) => {
      for (const id of input.ids) {
        await deleteBook(id);
      }
      return { deleted: input.ids.length };
    }),

  moveToFolder: publicProcedure
    .input(z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      folderId: z.string().uuid().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      if (input.folderId) {
        const [folder] = await db
          .select()
          .from(folders)
          .where(and(eq(folders.id, input.folderId), eq(folders.profileId, profileId)));
        if (!folder) throw new Error("Folder not found");
      }
      await db
        .update(books)
        .set({ folderId: input.folderId, updatedAt: new Date() })
        .where(and(inArray(books.id, input.ids), eq(books.profileId, profileId)));
      return { moved: input.ids.length };
    }),

  assemblies: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      return db
        .select()
        .from(assemblies)
        .where(eq(assemblies.bookId, input.bookId))
        .orderBy(desc(assemblies.createdAt));
    }),

  deleteAssembly: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [assembly] = await db.select().from(assemblies).where(eq(assemblies.id, input.id));
      if (!assembly) throw new Error("Assembly not found");

      if (assembly.outputPath) {
        await unlink(assembly.outputPath).catch(() => {});
      }

      // If this was the latest assembly (matches books.outputPath), clear it
      const [book] = await db.select().from(books).where(eq(books.id, assembly.bookId));
      if (book?.outputPath === assembly.outputPath) {
        // Find the next most recent assembly for this book
        const [nextAssembly] = await db
          .select()
          .from(assemblies)
          .where(and(eq(assemblies.bookId, assembly.bookId), ne(assemblies.id, input.id)))
          .orderBy(desc(assemblies.createdAt))
          .limit(1);

        await db
          .update(books)
          .set({
            outputPath: nextAssembly?.outputPath ?? null,
            updatedAt: new Date(),
          })
          .where(eq(books.id, assembly.bookId));
      }

      await db.delete(assemblies).where(eq(assemblies.id, input.id));
      return { success: true };
    }),
});
