import type { WorkerUtils } from "graphile-worker";
import { db } from "../db.ts";
import { books, bookFiles, chapters } from "../schema.ts";
import { eq, ne, and, asc, max } from "drizzle-orm";
import { extractPdf, ExtractAbortedError } from "../lib/marker.ts";
import { registerExtractAbort, clearExtractAbort } from "../lib/extract-registry.ts";
import { bookTmpDir } from "../lib/paths.ts";
import { appendLog } from "../lib/log.ts";
import path from "node:path";
import { assembleJobKey } from "../lib/output-readiness.ts";
import { queueIndexBook } from "../lib/search-index.ts";

export type ExtractPayload = {
  bookId: string;
};

export async function extract(payload: ExtractPayload, { addJob }: { addJob: WorkerUtils["addJob"] }) {
  const { bookId } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  await db.update(books).set({ status: "extracting", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));
  await log("Starting extraction");

  try {
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book) throw new Error(`Book ${bookId} not found`);
    if (book.kind !== "pdf") throw new Error("Synthetic books have no PDF to extract");

    const files = await db
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId))
      .orderBy(asc(bookFiles.index));

    if (files.length === 0) {
      // Legacy book without book_files rows — use book.pdfPath directly
      if (!book.pdfPath) throw new Error("Book has no PDF files");
      const abort = registerExtractAbort(bookId);
      try {
        await extractSinglePdf({ ...book, pdfPath: book.pdfPath }, bookTmpDir(bookId), log, addJob, 0, null, book.skipSynthesis, abort.signal);
      } finally {
        clearExtractAbort(bookId);
      }
    } else {
      // A run where every file was stopped by hand produced no chapters, which the check below
      // would report as "No chapters detected in any file" — a failure, for something deliberate.
      const { cancelled } = await extractMultipleFiles(book, files, log, addJob);
      if (cancelled) return;
    }

    // Count total chapters
    const [highest] = await db
      .select({ count: max(chapters.index) })
      .from(chapters)
      .where(eq(chapters.bookId, bookId));
    const totalChapters = highest?.count != null ? highest.count + 1 : 0;

    await db
      .update(books)
      .set({ totalChapters, status: "pending", updatedAt: new Date() })
      .where(eq(books.id, bookId));

    if (totalChapters === 0) {
      throw new Error("No chapters detected in any file");
    }

    if (book.skipSynthesis) {
      await log("Extraction complete in reader mode — chapters are suspended. Queue selected chapters when ready.");
    } else {
      await log("Extraction complete, queuing normalization");
      // The unattended upload path is the only one that promises an M4B. Recording that
      // intent here as a waiting job keeps it visible instead of surprising the user at
      // the end of every synthesis run.
      await addJob("assemble", { bookId, waitForAll: true }, {
        maxAttempts: 1,
        jobKey: assembleJobKey(bookId),
        jobKeyMode: "replace",
      });
      await log("M4B assembly queued — it runs once every chapter is synthesized");
    }
    await queueIndexBook(bookId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`Extraction failed: ${message}`);
    await db.update(books).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(books.id, bookId));
    throw err;
  }
}

async function extractSinglePdf(
  book: typeof books.$inferSelect & { pdfPath: string },
  tmpOut: string,
  log: (msg: string) => Promise<void>,
  addJob: WorkerUtils["addJob"],
  chapterOffset: number,
  sourceFileIndex: number | null,
  skipSynthesis: boolean,
  signal?: AbortSignal,
) {
  const { chapters: extractedChapters, method } = await extractPdf(book.pdfPath, tmpOut, log, {
    forceOcr: book.forceOcr,
    llmChapterDetection: book.llmChapterDetection,
    chapterModel: book.chapterModel ?? undefined,
    signal,
  });

  await log(`Detected ${extractedChapters.length} chapters (${method})`);
  await db.update(books).set({ chapterDetection: method, updatedAt: new Date() }).where(eq(books.id, book.id));

  for (const [i, ch] of extractedChapters.entries()) {
    const globalIndex = chapterOffset + i;
    const wordCount = ch.text.split(/\s+/).filter(Boolean).length;
    await log(`Chapter ${globalIndex + 1}: "${ch.title}" (${wordCount.toLocaleString()} words)`);

    const [inserted] = await db
      .insert(chapters)
      .values({
        bookId: book.id,
        index: globalIndex,
        title: ch.title,
        rawText: ch.text,
        pageStart: ch.pageStart,
        pageEnd: ch.pageEnd,
        sourceBlocks: ch.sourceBlocks,
        sourceFileIndex,
        status: skipSynthesis ? "suspended" : "pending",
      })
      .returning();

    if (!inserted) throw new Error("Failed to insert the extracted chapter");
    if (!skipSynthesis) {
      await addJob("normalize", { chapterId: inserted.id, bookId: book.id }, { maxAttempts: 1 });
    }
  }

  return extractedChapters.length;
}

async function extractMultipleFiles(
  book: typeof books.$inferSelect,
  files: (typeof bookFiles.$inferSelect)[],
  log: (msg: string) => Promise<void>,
  addJob: WorkerUtils["addJob"],
) {
  // Determine chapter offset from existing chapters (for append support)
  const [existing] = await db
    .select({ maxIndex: max(chapters.index) })
    .from(chapters)
    .where(eq(chapters.bookId, book.id));
  let chapterOffset = existing?.maxIndex != null ? existing.maxIndex + 1 : 0;

  let filesSucceeded = 0;
  let filesFailed = 0;
  let filesCancelled = 0;

  for (const file of files) {
    // Skip already-done files (append support) and raw-only files (extraction not requested)
    if (file.status === "done" || file.status === "raw") continue;

    // Re-read status to check for cancellation
    const [fresh] = await db.select({ status: bookFiles.status }).from(bookFiles).where(eq(bookFiles.id, file.id));
    if (fresh?.status === "failed") {
      await log(`Skipping cancelled file "${file.filename}"`);
      filesFailed++;
      continue;
    }

    const fileLog = (msg: string) => appendLog(book.id, msg, file.index);
    await fileLog(`Extracting file ${file.index + 1}: "${file.filename}"`);
    // Conditional claim: a cancel that landed while the file was still pending wins the race
    const [claimed] = await db
      .update(bookFiles)
      .set({ status: "extracting", error: null })
      .where(and(eq(bookFiles.id, file.id), ne(bookFiles.status, "failed")))
      .returning({ id: bookFiles.id });
    if (!claimed) {
      await fileLog(`Skipping cancelled file "${file.filename}"`);
      filesFailed++;
      continue;
    }

    const abort = registerExtractAbort(file.id);
    try {
      const tmpOut = path.join(bookTmpDir(book.id), `file_${file.index}`);
      const count = await extractSinglePdf(
        { ...book, pdfPath: file.pdfPath },
        tmpOut,
        fileLog,
        addJob,
        chapterOffset,
        file.index,
        file.skipSynthesis,
        abort.signal,
      );
      chapterOffset += count;
      filesSucceeded++;
      // Conditional so a late cancel (status already "failed") isn't overwritten with "done"
      await db
        .update(bookFiles)
        .set({ status: "done" })
        .where(and(eq(bookFiles.id, file.id), eq(bookFiles.status, "extracting")));
    } catch (err) {
      if (err instanceof ExtractAbortedError) {
        await fileLog(`Extraction of "${file.filename}" cancelled`);
        await db.update(bookFiles).set({ status: "suspended", error: null }).where(eq(bookFiles.id, file.id));
        // Counted apart from the failures: cancelling the only file used to make the run throw
        // "All 1 file(s) failed extraction", which set the book to failed with a message that does
        // not start with "Cancelled" — a red badge and a permanent "needs attention" for a
        // deliberate stop, which is the one thing a cancel must never leave behind.
        filesCancelled++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      await fileLog(`File "${file.filename}" failed: ${message}`);
      await db.update(bookFiles).set({ status: "failed", error: message }).where(eq(bookFiles.id, file.id));
      filesFailed++;
    } finally {
      clearExtractAbort(file.id);
    }
  }

  if (filesSucceeded === 0 && filesFailed > 0) {
    throw new Error(`All ${filesFailed} file(s) failed extraction`);
  }

  if (filesSucceeded === 0 && filesCancelled > 0) {
    await log(`Cancelled — ${filesCancelled} file(s) stopped, nothing extracted`);
    return { cancelled: true };
  }

  if (filesFailed > 0) {
    await log(`Warning: ${filesFailed} file(s) failed, ${filesSucceeded} succeeded`);
  }

  return { cancelled: false };
}
