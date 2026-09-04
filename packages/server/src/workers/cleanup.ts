import { db } from "../db.ts";
import { chapters, type ChapterCleanup } from "../schema.ts";
import { and, eq, sql } from "drizzle-orm";
import { splitIntoChunks } from "../lib/transform.ts";
import { cleanupChunk } from "../lib/cleanup.ts";
import { modelChoice } from "../lib/llm.ts";
import { describeError } from "../lib/errors.ts";
import { appendLog } from "../lib/log.ts";
import { randomUUID } from "node:crypto";
import { queueIndexBook } from "../lib/search-index.ts";

export type CleanupPayload = {
  chapterId: string;
  bookId: string;
};

export async function cleanup(payload: CleanupPayload) {
  const { chapterId, bookId } = payload;

  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
  if (!chapter) throw new Error(`Chapter ${chapterId} not found`);
  const chLog = (msg: string) => appendLog(bookId, `[Ch ${chapter.index + 1}] ${msg}`);
  if (chapter.cleanup?.status === "suspended") {
    await chLog("Cleanup skipped (stopped before start)");
    return;
  }

  // The token fences out any older run still writing to this chapter's cleanup state
  const runToken = randomUUID();
  const startedAt = new Date().toISOString();
  const state = (patch: Partial<ChapterCleanup>): ChapterCleanup => ({
    status: "cleaning",
    runToken,
    createdAt: startedAt,
    updatedAt: new Date().toISOString(),
    ...patch,
  });

  const transitioned = await db
    .update(chapters)
    .set({ cleanup: state({}) })
    .where(and(eq(chapters.id, chapterId), sql`${chapters.cleanup}->>'status' is distinct from 'suspended'`))
    .returning({ id: chapters.id });
  if (transitioned.length === 0) {
    await chLog("Cleanup skipped (stopped before start)");
    return;
  }
  const owned = and(
    eq(chapters.id, chapterId),
    sql`${chapters.cleanup}->>'status' is distinct from 'suspended'`,
    sql`${chapters.cleanup}->>'runToken' = ${runToken}`,
  );

  try {
    const source = chapter.customText ?? chapter.cleanText ?? chapter.rawText;
    if (!source) throw new Error("Chapter has no text");

    const chunks = splitIntoChunks(source);
    const model = await modelChoice();
    if (model.steppedOver) {
      await chLog(`Default model ${model.steppedOver} is not available — cleaning with ${model.label} instead`);
    }
    await chLog(`Cleaning "${chapter.title}" (${chunks.length} chunks) with ${model.label}`);
    // Written before the first chunk: a chapter that shows no progress for the minutes one takes
    // reads as stuck, which is how a working run got reported as a broken feature.
    await db.update(chapters).set({ cleanup: state({ progress: `0/${chunks.length}`, model: model.label }) }).where(owned);

    // Cleaned chunks accumulate in memory and land in customText in one final
    // write — an interrupted run must never leave a truncated chapter behind.
    const cleaned: string[] = [];
    for (const [i, chunk] of chunks.entries()) {
      cleaned.push(await cleanupChunk({ text: chunk }));

      const updated = await db
        .update(chapters)
        .set({ cleanup: state({ progress: `${i + 1}/${chunks.length}`, model: model.label }) })
        .where(owned)
        .returning({ id: chapters.id });
      if (updated.length === 0) {
        await chLog(`Cleanup stopped — chapter text unchanged`);
        return;
      }
    }

    const result = cleaned.filter(Boolean).join("\n\n");
    if (!result) throw new Error("Cleanup removed all text — chapter left unchanged");

    const finished = await db
      .update(chapters)
      .set({ customText: result, cleanup: state({ status: "done", progress: `${chunks.length}/${chunks.length}`, model: model.label }) })
      .where(owned)
      .returning({ id: chapters.id });
    if (finished.length === 0) {
      await chLog(`Cleanup stopped — chapter text unchanged`);
      return;
    }
    await chLog(`Cleanup done (${source.length} → ${result.length} chars)`);
    await queueIndexBook(bookId);
  } catch (err) {
    const message = describeError(err);
    await chLog(`Cleanup failed: ${message}`);
    await db
      .update(chapters)
      .set({ cleanup: state({ status: "failed", error: message }) })
      .where(owned);
    throw err;
  }
}
