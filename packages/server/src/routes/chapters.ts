import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { books, chapters, type Chapter, type ChapterCleanup } from "../schema.ts";
import { eq, and, inArray, sql } from "drizzle-orm";
import { appendLog } from "../lib/log.ts";
import { quickAddJob } from "graphile-worker";
import { env } from "../env.ts";
import { blocksAtRange, chapterChunkPreviewDir, listChapterChunkPreviews, locateChunks, pageAtOffset, syncMapChunkPreviews, audioCacheKey } from "../lib/chunk-previews.ts";
import { dirSize } from "../lib/disk-usage.ts";
import { stat } from "node:fs/promises";
import type { SourceBlock } from "../lib/marker.ts";
import { removeChapterArtifacts } from "../lib/chapter-artifacts.ts";
import { queueIndexBook } from "../lib/search-index.ts";

const connectionString = env.DATABASE_URL;

const STALE_RUNNING_MS = 15 * 60_000;

function cleanupRunning(cleanup: ChapterCleanup | null | undefined): boolean {
  if (!cleanup) return false;
  if (cleanup.status !== "pending" && cleanup.status !== "cleaning") return false;
  return Date.now() - Date.parse(cleanup.updatedAt) < STALE_RUNNING_MS;
}

// Requeueing without this leaves the old job behind and two workers end up
// racing on the same chapter's cleanup state.
async function deleteQueuedCleanupJobs(chapterIds: string[]) {
  if (chapterIds.length === 0) return;
  await db.execute(sql`
    DELETE FROM graphile_worker._private_jobs j
    USING graphile_worker._private_tasks t
    WHERE t.id = j.task_id AND t.identifier = 'cleanup'
      AND (j.payload ->> 'chapterId') IN (SELECT json_array_elements_text(${JSON.stringify(chapterIds)}::json))
      AND j.locked_at IS NULL
  `);
}

async function queueCleanupFor(chapter: Chapter) {
  const now = new Date().toISOString();
  await db
    .update(chapters)
    .set({ cleanup: { status: "pending", createdAt: now, updatedAt: now } })
    .where(eq(chapters.id, chapter.id));
  await deleteQueuedCleanupJobs([chapter.id]);
  await quickAddJob({ connectionString }, "cleanup", { chapterId: chapter.id, bookId: chapter.bookId }, { maxAttempts: 1 });
  await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] Queued cleanup`);
}

export const chaptersRouter = router({
  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");

      // The synthesized text — and therefore what chunk offsets point into — follows this priority.
      const chunkTextSource = chapter.customText ? "custom" : chapter.cleanText ? "clean" : "raw";
      const sourceText = chapter.customText ?? chapter.cleanText ?? chapter.rawText;

      let previews = await listChapterChunkPreviews(chapter.bookId, chapter.index);
      if (previews.length === 0) {
        const cacheKey = await audioCacheKey(chapter.audioPath);
        previews = await syncMapChunkPreviews(chapter.audioPath, `/audio/chapter/${chapter.id}${cacheKey}`);
      }
      const ranges = locateChunks(sourceText, previews.map((p) => p.text ?? ""));
      const blocks = Array.isArray(chapter.sourceBlocks) ? (chapter.sourceBlocks as SourceBlock[]) : [];
      // The map normalize wrote describes cleanText, so it only answers for chunks taken from it
      const textMap = chunkTextSource === "clean" ? chapter.textMap : null;

      // Without a map, offsets into clean/custom text are scaled onto rawText for an
      // approximate page, bounded by the chapter's own page range either way.
      const pageForRange = (range: { start: number; end: number }): number | null => {
        const [exactBlock] = textMap ? blocksAtRange(textMap, range.start, range.end) : [];
        if (exactBlock !== undefined) return blocks[exactBlock]?.page ?? null;
        const rawOffset =
          chunkTextSource === "raw"
            ? range.start
            : Math.round((range.start / Math.max(sourceText.length, 1)) * chapter.rawText.length);
        return pageAtOffset(blocks, chapter.rawText.length, rawOffset);
      };

      const chunkPreviews = previews.map((preview, i) => {
        const range = ranges[i];
        if (!range) return preview;
        const page = pageForRange(range) ?? chapter.pageStart ?? undefined;
        return { ...preview, start: range.start, end: range.end, ...(page !== undefined ? { page } : {}) };
      });

      return {
        ...chapter,
        chunkTextSource,
        chunkPreviews,
      };
    }),

  queue: publicProcedure
    .input(z.object({ id: z.string().uuid(), resume: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");

      if (chapter.status === "synthesizing" || chapter.status === "normalizing") {
        throw new Error("Chapter is already being processed");
      }

      // Resume reuses already-synthesized chunk previews; keep `progress` so the count survives.
      await db
        .update(chapters)
        .set({ status: "pending", error: null, audioPath: null, durationMs: null, synthesizedWith: null })
        .where(eq(chapters.id, input.id));

      if (chapter.cleanText) {
        await quickAddJob({ connectionString }, "synthesize", {
          chapterId: input.id,
          bookId: chapter.bookId,
          resume: input.resume ?? false,
        }, { maxAttempts: 1 });
      } else {
        await quickAddJob({ connectionString }, "normalize", {
          chapterId: input.id,
          bookId: chapter.bookId,
        }, { maxAttempts: 1 });
      }

      await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] ${input.resume ? "Resuming" : "Queued"}`);
      return { success: true };
    }),

  suspend: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");

      if (chapter.status === "done") {
        throw new Error("Cannot suspend a completed chapter");
      }
      if (chapter.status === "synthesizing" || chapter.status === "normalizing") {
        throw new Error("Cannot suspend a chapter that is actively processing");
      }

      await db
        .update(chapters)
        .set({ status: "suspended", error: null })
        .where(eq(chapters.id, input.id));

      await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] Suspended`);
      return { success: true };
    }),

  setSelected: publicProcedure
    .input(z.object({ id: z.string().uuid(), selected: z.boolean() }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");

      await db
        .update(chapters)
        .set({ selected: input.selected })
        .where(eq(chapters.id, input.id));

      return { success: true };
    }),

  setSelectedBatch: publicProcedure
    .input(z.object({ ids: z.array(z.string().uuid()), selected: z.boolean() }))
    .mutation(async ({ input }) => {
      if (input.ids.length === 0) return { success: true };
      await db
        .update(chapters)
        .set({ selected: input.selected })
        .where(inArray(chapters.id, input.ids));
      return { success: true };
    }),

  setAllSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), selected: z.boolean() }))
    .mutation(async ({ input }) => {
      await db
        .update(chapters)
        .set({ selected: input.selected })
        .where(eq(chapters.bookId, input.bookId));

      return { success: true };
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string().uuid(), title: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await db.update(chapters).set({ title: input.title }).where(eq(chapters.id, input.id));
      return { success: true };
    }),

  updateText: publicProcedure
    .input(z.object({ id: z.string().uuid(), customText: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");

      await db
        .update(chapters)
        .set({ customText: input.customText })
        .where(eq(chapters.id, input.id));

      await queueIndexBook(chapter.bookId);
      return { success: true };
    }),

  resetText: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");

      await db
        .update(chapters)
        .set({ customText: null })
        .where(eq(chapters.id, input.id));

      await queueIndexBook(chapter.bookId);
      return { success: true };
    }),

  queueCleanup: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");
      if (cleanupRunning(chapter.cleanup)) throw new Error("Cleanup is already running");

      await queueCleanupFor(chapter);
      return { success: true };
    }),

  stopCleanup: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.id));
      if (!chapter) throw new Error("Chapter not found");
      if (chapter.cleanup?.status !== "pending" && chapter.cleanup?.status !== "cleaning") {
        throw new Error("Cleanup is not running");
      }

      await db
        .update(chapters)
        .set({ cleanup: { ...chapter.cleanup, status: "suspended", updatedAt: new Date().toISOString() } })
        .where(eq(chapters.id, input.id));
      await deleteQueuedCleanupJobs([input.id]);
      await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] Cleanup stopped`);
      return { success: true };
    }),

  cleanupSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const selected = await db
        .select()
        .from(chapters)
        .where(and(eq(chapters.bookId, input.bookId), eq(chapters.selected, true)));

      const queueable = selected.filter((ch) => ch.cleanup?.status !== "done" && !cleanupRunning(ch.cleanup));
      if (queueable.length === 0) {
        throw new Error("No selected chapters need cleanup — already-cleaned ones are skipped");
      }

      for (const ch of queueable) {
        await queueCleanupFor(ch);
      }
      return { queued: queueable.length };
    }),

  reorder: publicProcedure
    .input(z.object({
      bookId: z.string().uuid(),
      chapterIds: z.array(z.string().uuid()),
    }))
    .mutation(async ({ input }) => {
      // chapterIds is the new order — index 0 gets index=0, index 1 gets index=1, etc.
      for (const [i, chapterId] of input.chapterIds.entries()) {
        await db
          .update(chapters)
          .set({ index: i })
          .where(and(eq(chapters.id, chapterId), eq(chapters.bookId, input.bookId)));
      }
      return { success: true };
    }),

  textStats: publicProcedure
    .input(z.object({ chapterIds: z.array(z.string().uuid()).min(1).max(500) }))
    .query(async ({ input }) => {
      const rows = await db
        .select({ rawText: chapters.rawText, cleanText: chapters.cleanText, customText: chapters.customText })
        .from(chapters)
        .where(inArray(chapters.id, input.chapterIds));
      let ascii = 0;
      let nonAscii = 0;
      for (const ch of rows) {
        const text = ch.customText ?? ch.cleanText ?? ch.rawText;
        const non = (text.match(/[^\x00-\x7F]/g) ?? []).length;
        nonAscii += non;
        ascii += text.length - non;
      }
      return { ascii, nonAscii, chapterCount: rows.length };
    }),

  selectedAudioSize: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      const selected = await db
        .select({ index: chapters.index, audioPath: chapters.audioPath })
        .from(chapters)
        .where(and(eq(chapters.bookId, input.bookId), eq(chapters.selected, true)));

      let bytes = 0;
      let count = 0;
      for (const ch of selected) {
        let chBytes = 0;
        if (ch.audioPath) {
          chBytes += (await stat(ch.audioPath).catch(() => null))?.size ?? 0;
        }
        chBytes += await dirSize(chapterChunkPreviewDir(input.bookId, ch.index));
        if (chBytes > 0) {
          bytes += chBytes;
          count++;
        }
      }
      return { bytes, count };
    }),

  deleteAudioSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const selected = await db
        .select()
        .from(chapters)
        .where(and(eq(chapters.bookId, input.bookId), eq(chapters.selected, true)));

      const active = selected.filter((c) => ["pending", "normalizing", "synthesizing"].includes(c.status));
      if (active.length > 0) {
        throw new Error(`Cannot delete audio of ${active.length} chapter(s) that are actively processing`);
      }

      // Partial chapters count too: their chunk WAVs are audio data even without a final encode
      const targets = selected.filter((c) => c.audioPath || c.progress);
      for (const ch of targets) {
        await removeChapterArtifacts({ bookId: ch.bookId, index: ch.index, audioPath: ch.audioPath });
      }

      if (targets.length > 0) {
        await db
          .update(chapters)
          .set({ audioPath: null, durationMs: null, progress: null, synthesizedWith: null, error: null, status: "suspended" })
          .where(inArray(chapters.id, targets.map((c) => c.id)));
        await appendLog(input.bookId, `Deleted audio of ${targets.length} chapter(s) — text kept`);
      }

      return { count: targets.length };
    }),

  deleteSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const selected = await db
        .select()
        .from(chapters)
        .where(and(eq(chapters.bookId, input.bookId), eq(chapters.selected, true)));

      const active = selected.filter((c) => c.status === "synthesizing" || c.status === "normalizing");
      if (active.length > 0) {
        throw new Error(`Cannot delete ${active.length} chapter(s) that are actively processing`);
      }

      for (const ch of selected) {
        await removeChapterArtifacts({ bookId: ch.bookId, index: ch.index, audioPath: ch.audioPath });
      }

      await db
        .delete(chapters)
        .where(and(eq(chapters.bookId, input.bookId), eq(chapters.selected, true)));

      // Update total count
      const remaining = await db.select({ id: chapters.id }).from(chapters).where(eq(chapters.bookId, input.bookId));
      await db.update(books).set({ totalChapters: remaining.length, updatedAt: new Date() }).where(eq(books.id, input.bookId));

      await appendLog(input.bookId, `Deleted ${selected.length} selected chapter(s)`);
      return { success: true };
    }),
});
