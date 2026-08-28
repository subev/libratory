import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { books, bookFiles, chapters } from "../schema.ts";
import { eq, and, asc, inArray } from "drizzle-orm";
import { appendLog } from "../lib/log.ts";
import { bookTmpDir } from "../lib/paths.ts";
import { quickAddJob } from "graphile-worker";
import { env } from "../env.ts";
import { unlink, rm } from "node:fs/promises";
import path from "node:path";
import { removeChapterArtifacts } from "../lib/chapter-artifacts.ts";
import { abortExtract } from "../lib/extract-registry.ts";

const connectionString = env.DATABASE_URL;

async function deleteChaptersForFile(bookId: string, fileIndex: number) {
  const fileChapters = await db
    .select({ id: chapters.id, index: chapters.index, audioPath: chapters.audioPath })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.sourceFileIndex, fileIndex)));

  for (const ch of fileChapters) {
    await removeChapterArtifacts({ bookId, index: ch.index, audioPath: ch.audioPath });
  }

  await db
    .delete(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.sourceFileIndex, fileIndex)));

  return fileChapters.length;
}

// books.pdfPath predates book_files, and three places still read it as "the book's only PDF" when
// no rows remain — the legacy single-file shape. Left pointing at a file that was just deleted, it
// resurrects that file the next time one is added, so it follows the rows it describes.
async function repointBookPdf(bookId: string) {
  const [first] = await db
    .select({ pdfPath: bookFiles.pdfPath, filename: bookFiles.filename })
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId))
    .orderBy(asc(bookFiles.index))
    .limit(1);

  await db
    .update(books)
    .set({ pdfPath: first?.pdfPath ?? null, filename: first?.filename ?? null, updatedAt: new Date() })
    .where(eq(books.id, bookId));
}

function guardActiveChapters(fileChapters: { status: string }[]) {
  const active = fileChapters.filter((c) => c.status === "synthesizing" || c.status === "normalizing");
  if (active.length > 0) {
    throw new Error(`Cannot modify file while ${active.length} chapter(s) are actively processing`);
  }
}

async function updateBookTotalChapters(bookId: string) {
  const remaining = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.bookId, bookId));

  await db
    .update(books)
    .set({ totalChapters: remaining.length, updatedAt: new Date() })
    .where(eq(books.id, bookId));
}

export const bookFilesRouter = router({
  setSelected: publicProcedure
    .input(z.object({ id: z.string().uuid(), selected: z.boolean() }))
    .mutation(async ({ input }) => {
      await db
        .update(bookFiles)
        .set({ selected: input.selected })
        .where(eq(bookFiles.id, input.id));
      return { success: true };
    }),

  setSelectedBatch: publicProcedure
    .input(z.object({ ids: z.array(z.string().uuid()), selected: z.boolean() }))
    .mutation(async ({ input }) => {
      if (input.ids.length === 0) return { success: true };
      await db
        .update(bookFiles)
        .set({ selected: input.selected })
        .where(inArray(bookFiles.id, input.ids));
      return { success: true };
    }),

  setAllSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), selected: z.boolean() }))
    .mutation(async ({ input }) => {
      await db
        .update(bookFiles)
        .set({ selected: input.selected })
        .where(eq(bookFiles.bookId, input.bookId));
      return { success: true };
    }),

  setSkipSynthesis: publicProcedure
    .input(z.object({ id: z.string().uuid(), skipSynthesis: z.boolean() }))
    .mutation(async ({ input }) => {
      await db
        .update(bookFiles)
        .set({ skipSynthesis: input.skipSynthesis })
        .where(eq(bookFiles.id, input.id));
      return { success: true };
    }),

  remove: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [file] = await db.select().from(bookFiles).where(eq(bookFiles.id, input.id));
      if (!file) throw new Error("File not found");

      const fileChapters = await db
        .select({ status: chapters.status })
        .from(chapters)
        .where(and(eq(chapters.bookId, file.bookId), eq(chapters.sourceFileIndex, file.index)));

      guardActiveChapters(fileChapters);

      const deletedCount = await deleteChaptersForFile(file.bookId, file.index);
      await db.delete(bookFiles).where(eq(bookFiles.id, input.id));
      await repointBookPdf(file.bookId);
      await unlink(file.pdfPath).catch(() => {});
      await rm(path.join(bookTmpDir(file.bookId), `file_${file.index}`), { recursive: true, force: true }).catch(() => {});
      await updateBookTotalChapters(file.bookId);
      await appendLog(file.bookId, `Removed file "${file.filename}" and ${deletedCount} chapter(s)`);

      return { success: true };
    }),

  reExtract: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [file] = await db.select().from(bookFiles).where(eq(bookFiles.id, input.id));
      if (!file) throw new Error("File not found");

      const fileChapters = await db
        .select({ status: chapters.status })
        .from(chapters)
        .where(and(eq(chapters.bookId, file.bookId), eq(chapters.sourceFileIndex, file.index)));

      guardActiveChapters(fileChapters);

      const deletedCount = await deleteChaptersForFile(file.bookId, file.index);
      await rm(path.join(bookTmpDir(file.bookId), `file_${file.index}`), { recursive: true, force: true }).catch(() => {});

      await db
        .update(bookFiles)
        .set({ status: "pending", error: null })
        .where(eq(bookFiles.id, input.id));

      await db
        .update(books)
        .set({ status: "pending", error: null, updatedAt: new Date() })
        .where(eq(books.id, file.bookId));

      await updateBookTotalChapters(file.bookId);
      await appendLog(file.bookId, `Re-extracting file "${file.filename}" (removed ${deletedCount} chapter(s))`);
      await quickAddJob({ connectionString }, "extract", { bookId: file.bookId }, { maxAttempts: 1 });

      return { success: true };
    }),

  reExtractSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.bookId));
      if (!book) throw new Error("Book not found");
      const selectedFiles = await db
        .select()
        .from(bookFiles)
        .where(and(eq(bookFiles.bookId, input.bookId), eq(bookFiles.selected, true)));

      if (selectedFiles.length === 0) throw new Error("No files selected");

      // Every file is checked before any is touched. Guarding inside the loop below meant that
      // selecting two files where only the second was mid-synthesis deleted the first one's
      // chapters, audio and edits, then threw — losing work to a request that did nothing.
      for (const file of selectedFiles) {
        const fileChapters = await db
          .select({ status: chapters.status })
          .from(chapters)
          .where(and(eq(chapters.bookId, input.bookId), eq(chapters.sourceFileIndex, file.index)));
        guardActiveChapters(fileChapters);
      }

      for (const file of selectedFiles) {
        await deleteChaptersForFile(input.bookId, file.index);
        await rm(path.join(bookTmpDir(input.bookId), `file_${file.index}`), { recursive: true, force: true }).catch(() => {});

        await db
          .update(bookFiles)
          .set({ status: "pending", error: null })
          .where(eq(bookFiles.id, file.id));
      }

      await db
        .update(books)
        .set({ status: "pending", error: null, updatedAt: new Date() })
        .where(eq(books.id, input.bookId));

      await updateBookTotalChapters(input.bookId);
      await appendLog(input.bookId, `Re-extracting ${selectedFiles.length} selected file(s)`);
      await quickAddJob({ connectionString }, "extract", { bookId: input.bookId }, { maxAttempts: 1 });

      return { success: true };
    }),

  cancel: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [file] = await db.select().from(bookFiles).where(eq(bookFiles.id, input.id));
      if (!file) throw new Error("File not found");

      if (file.status !== "extracting" && file.status !== "pending") {
        throw new Error("File is not extracting or pending");
      }

      await db
        .update(bookFiles)
        .set({ status: "suspended", error: null })
        .where(eq(bookFiles.id, input.id));

      const killed = abortExtract(input.id);
      await appendLog(
        file.bookId,
        killed
          ? `Cancelled extraction of "${file.filename}" — stopped the running process`
          : `Cancelled extraction of "${file.filename}"`,
      );
      return { success: true };
    }),
});
