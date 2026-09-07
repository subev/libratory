import { db } from "../db.ts";
import { books, bookFiles, chapters, assemblies, documents } from "../schema.ts";
import { eq, asc } from "drizzle-orm";
import { redetectChaptersFromExistingMarkerOutput } from "../lib/marker.ts";
import { bookTmpDir, bookOutputDir } from "../lib/paths.ts";
import { readablePdfPath } from "../lib/pdf-raw-text.ts";
import { appendLog } from "../lib/log.ts";
import { insertSuspendedChapters, resetChaptersKeepingInserted } from "../lib/insert-chapters.ts";
import { rm } from "node:fs/promises";
import path from "node:path";
import { queueIndexBook } from "../lib/search-index.ts";

export type RedetectPayload = {
  bookId: string;
};

export async function redetect(payload: RedetectPayload) {
  const { bookId } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) throw new Error(`Book ${bookId} not found`);
  // Must be checked before any deletion — re-detection reads marker output that synthetic books never have
  if (book.kind !== "pdf") throw new Error("Cannot re-detect chapters on a synthetic book");

  await db.update(books).set({ status: "extracting", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));

  try {
    const allChapters = await db
      .select({
        audioPath: chapters.audioPath,
        title: chapters.title,
        pageStart: chapters.pageStart,
        pageEnd: chapters.pageEnd,
      })
      .from(chapters)
      .where(eq(chapters.bookId, bookId));

    const oldSignature = allChapters
      .map((c) => `${c.title}|${c.pageStart ?? ""}|${c.pageEnd ?? ""}`)
      .join("\n");

    const bookAssemblies = await db
      .select({ id: assemblies.id })
      .from(assemblies)
      .where(eq(assemblies.bookId, bookId));

    const deletedAudioFiles = allChapters.filter((ch) => ch.audioPath).length;
    await rm(bookOutputDir(bookId), { recursive: true, force: true }).catch(() => {});

    await db.delete(assemblies).where(eq(assemblies.bookId, bookId));
    await db.delete(documents).where(eq(documents.bookId, bookId));
    const keptCount = await resetChaptersKeepingInserted(bookId);

    await log("Re-detecting chapters from existing extraction output");
    await log(
      `Removed ${allChapters.length - keptCount} existing chapter${allChapters.length - keptCount === 1 ? "" : "s"}, ${bookAssemblies.length} assembl${bookAssemblies.length === 1 ? "y" : "ies"}, and ${deletedAudioFiles} chapter audio file${deletedAudioFiles === 1 ? "" : "s"}`
    );
    if (keptCount > 0) {
      await log(`Kept ${keptCount} inserted chapter${keptCount === 1 ? "" : "s"} (moved to the front, audio reset)`);
    }

    const files = await db
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId))
      .orderBy(asc(bookFiles.index));

    let totalDetected = 0;
    let detectionMethod: typeof books.$inferSelect.chapterDetection = null;

    if (files.length === 0) {
      // Legacy single-file book
      if (!book.pdfPath) throw new Error("Book has no PDF files");
      const { chapters: detected, method } = await redetectChaptersFromExistingMarkerOutput(bookTmpDir(bookId), book.pdfPath, log, {
        llmChapterDetection: book.llmChapterDetection,
        chapterModel: book.chapterModel ?? undefined,
      });
      totalDetected = detected.length;
      detectionMethod = method;
      await insertSuspendedChapters(bookId, detected, keptCount, null);
    } else {
      // Multi-file book: re-detect per file
      let chapterOffset = keptCount;
      for (const file of files) {
        const fileTmpDir = path.join(bookTmpDir(bookId), `file_${file.index}`);
        try {
          const { chapters: detected, method } = await redetectChaptersFromExistingMarkerOutput(fileTmpDir, readablePdfPath(file), log, {
            llmChapterDetection: book.llmChapterDetection,
            chapterModel: book.chapterModel ?? undefined,
          });
          await insertSuspendedChapters(bookId, detected, chapterOffset, file.index);
          chapterOffset += detected.length;
          totalDetected += detected.length;
          detectionMethod = method;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await log(`Re-detection failed for "${file.filename}": ${message}`);
        }
      }
    }

    if (totalDetected === 0) {
      throw new Error("No chapters detected from existing extraction output");
    }

    await log(`Detected ${totalDetected} chapters (${detectionMethod})`);

    const newChapters = await db
      .select({ title: chapters.title, pageStart: chapters.pageStart, pageEnd: chapters.pageEnd })
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .orderBy(asc(chapters.index));

    const newSignature = newChapters
      .map((c) => `${c.title}|${c.pageStart ?? ""}|${c.pageEnd ?? ""}`)
      .join("\n");

    if (oldSignature === newSignature) {
      await log("Chapter boundaries unchanged from previous detection");
    } else {
      await log("Chapter boundaries updated");
    }

    await log("Chapter re-detection complete — chapters are suspended. Queue selected chapters when ready.");

    await db
      .update(books)
      .set({ totalChapters: keptCount + totalDetected, chapterDetection: detectionMethod, status: "pending", updatedAt: new Date() })
      .where(eq(books.id, bookId));
    await queueIndexBook(bookId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`Chapter re-detection failed: ${message}`);
    await db.update(books).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(books.id, bookId));
    throw err;
  }
}
