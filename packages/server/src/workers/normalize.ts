import type { WorkerUtils } from "graphile-worker";
import { db } from "../db.ts";
import { chapters, type ChapterTextMap } from "../schema.ts";
import { and, eq, ne } from "drizzle-orm";
import { normalizeForTts, normalizeBlocks } from "../lib/normalizer.ts";
import type { SourceBlock } from "../lib/marker.ts";
import { joinTextBlocks } from "../lib/extracted-text.ts";
import { appendLog } from "../lib/log.ts";
import { queueIndexBook } from "../lib/search-index.ts";
import { synthesisJobSpec } from "../lib/synthesis-jobs.ts";

export type NormalizePayload = {
  chapterId: string;
  bookId: string;
};

// Blocks that no longer rebuild rawText would map offsets onto the wrong paragraph
export function normalizeChapter(rawText: string, sourceBlocks: unknown): { cleanText: string; textMap: ChapterTextMap | null } {
  const blocks = Array.isArray(sourceBlocks) ? (sourceBlocks as SourceBlock[]) : [];
  const rebuilt = joinTextBlocks(blocks).text;
  if (blocks.length === 0 || rebuilt !== rawText) return { cleanText: normalizeForTts(rawText), textMap: null };

  const { text, spans } = normalizeBlocks(blocks);
  return { cleanText: text, textMap: { version: 1, spans } };
}

export async function normalize(payload: NormalizePayload, { addJob }: { addJob: WorkerUtils["addJob"] }) {
  const { chapterId, bookId } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  try {
    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
    if (!chapter) throw new Error(`Chapter ${chapterId} not found`);
    if (chapter.status === "suspended") {
      await log(`[Ch ${chapter.index + 1}] Skipped normalize (suspended)`);
      return;
    }

    const updated = await db
      .update(chapters)
      .set({ status: "normalizing", error: null })
      .where(and(eq(chapters.id, chapterId), ne(chapters.status, "suspended")))
      .returning({ id: chapters.id });

    if (updated.length === 0) {
      await log(`[Ch ${chapter.index + 1}] Skipped normalize (suspended)`);
      return;
    }

    await log(`Normalizing chapter ${chapter.index + 1}: "${chapter.title}"`);

    const { cleanText, textMap } = normalizeChapter(chapter.rawText, chapter.sourceBlocks);

    const [latest] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
    if (!latest || latest.status === "suspended") {
      await log(`[Ch ${chapter.index + 1}] Skipped synth queue (suspended)`);
      return;
    }

    await db
      .update(chapters)
      .set({ cleanText, textMap, status: "pending" })
      .where(eq(chapters.id, chapterId));

    await queueIndexBook(bookId);
    await addJob("synthesize", { chapterId, bookId }, await synthesisJobSpec(bookId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`Normalization failed for chapter ${chapterId}: ${message}`);
    await db.update(chapters).set({ status: "failed", error: message }).where(eq(chapters.id, chapterId));
    throw err;
  }
}
