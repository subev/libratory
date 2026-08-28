import { db } from "../db.ts";
import { chapters, chapterVariants } from "../schema.ts";
import { eq, and, ne } from "drizzle-orm";
import { translateTitle } from "../lib/translate.ts";
import { chunksForVariant, variantChunkFn, variantLabel } from "../lib/transform.ts";
import { describeError } from "../lib/errors.ts";
import { appendLog } from "../lib/log.ts";
import { createHash, randomUUID } from "node:crypto";
import type { WorkerUtils } from "graphile-worker";
import { queueIndexBook } from "../lib/search-index.ts";
import { beginTranslationLive, type TranslationLiveHandle } from "../lib/translate-live.ts";

export type TranslatePayload = {
  translationId: string;
  bookId: string;
};

export async function translate(
  payload: TranslatePayload,
  { addJob }: { addJob: WorkerUtils["addJob"] },
) {
  const { translationId, bookId } = payload;

  const [row] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId));
  if (!row) throw new Error(`Translation ${translationId} not found`);
  if (row.status === "suspended") return;

  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, row.chapterId));
  if (!chapter) throw new Error(`Chapter ${row.chapterId} not found`);

  const chLog = (msg: string) => appendLog(bookId, `[Ch ${chapter.index + 1}] ${msg}`);

  // The token fences out any older run still writing to this row: their guarded
  // updates match zero rows from here on, so duplicate jobs can't interleave text.
  const runToken = randomUUID();
  const transitioned = await db
    .update(chapterVariants)
    .set({ status: "translating", error: null, runToken, updatedAt: new Date() })
    .where(and(eq(chapterVariants.id, translationId), ne(chapterVariants.status, "suspended")))
    .returning({ id: chapterVariants.id });
  if (transitioned.length === 0) {
    await chLog("Translation skipped (stopped before start)");
    return;
  }
  const owned = and(
    eq(chapterVariants.id, translationId),
    ne(chapterVariants.status, "suspended"),
    eq(chapterVariants.runToken, runToken),
  );

  let live: TranslationLiveHandle | undefined;
  try {
    const source = chapter.customText ?? chapter.cleanText ?? chapter.rawText;
    if (!source) throw new Error("Chapter has no text");

    const label = variantLabel(row);
    const runChunk = variantChunkFn(row);
    const chunks = chunksForVariant(source, row);
    const sourceHash = createHash("sha256").update(source).digest("hex");

    // Resume only when the source is byte-identical to what the partial was translated from.
    let done = 0;
    const match = row.progress?.match(/^(\d+)\/(\d+)$/);
    if (row.text && match && Number(match[2]) === chunks.length && row.sourceHash === sourceHash) {
      done = Math.min(Number(match[1]), chunks.length);
    }
    let translated = done > 0 ? row.text : "";
    const existingTitle = done > 0 ? row.title : null;
    if (done === 0) {
      await db.update(chapterVariants).set({ text: "", progress: null, title: null, sourceHash, updatedAt: new Date() })
        .where(owned);
    }

    const isTranslation = row.kind === "translation";
    await chLog(
      done > 0
        ? `Resuming ${isTranslation ? `translation to ${label}` : `${label} rewrite`} (${done}/${chunks.length} chunks done)`
        : `${isTranslation ? `Translating "${chapter.title}" to ${label}` : `Rewriting "${chapter.title}" as ${label}`} (${chunks.length} chunks)`,
    );

    live = beginTranslationLive(translationId, translated);

    for (const [i, chunk] of chunks.entries()) {
      if (i < done) continue;
      if (translated) live.append("\n\n");
      const result = await runChunk({
        text: chunk,
        previousOutput: translated ? translated.slice(-1500) : undefined,
        onDelta: live.append,
        onThinking: live.think,
      });

      translated = translated ? `${translated}\n\n${result}` : result;
      live.sync(translated);

      const updated = await db
        .update(chapterVariants)
        .set({ text: translated, progress: `${i + 1}/${chunks.length}`, updatedAt: new Date() })
        .where(owned)
        .returning({ id: chapterVariants.id });

      if (updated.length === 0) {
        await chLog(`Translation stopped — kept ${i}/${chunks.length} chunks`);
        live.end("suspended");
        return;
      }
    }

    const title = existingTitle ?? (isTranslation
      ? await translateTitle({
          title: chapter.title,
          language: row.key,
          translatedOpening: translated.slice(0, 1000),
          thinking: row.params?.thinking ?? false,
          model: row.params?.model,
        })
      : chapter.title);

    const [finished] = await db
      .update(chapterVariants)
      .set({ status: "done", title, updatedAt: new Date() })
      .where(owned)
      .returning({ audioStatus: chapterVariants.audioStatus });
    if (!finished) {
      await chLog(`Translation stopped — kept ${chunks.length}/${chunks.length} chunks`);
      live.end("suspended");
      return;
    }
    live.end("done");
    await chLog(`${isTranslation ? `Translation to ${label}` : `${label} rewrite`} done`);
    await queueIndexBook(bookId);

    // Synthesis queued while this variant was still running waits as audioStatus=pending
    if (finished.audioStatus === "pending") {
      await chLog(`Starting queued ${label} synthesis`);
      await addJob("synthesizeTranslation", { translationId, bookId }, { maxAttempts: 1 });
    }
  } catch (err) {
    const message = describeError(err);
    live?.end("failed", message);
    await chLog(`Translation failed: ${message}`);
    await db
      .update(chapterVariants)
      .set({ status: "failed", error: message, updatedAt: new Date() })
      .where(owned);
    throw err;
  }
}
