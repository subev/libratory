import { db } from "../db.ts";
import { chapters, books } from "../schema.ts";
import { eq, and, ne, notInArray } from "drizzle-orm";
import { synthesize as ttsSynthesize, TtsAbortedError, voiceSupportsSpeed } from "../lib/tts.ts";
import { encodeToM4a } from "../lib/ffmpeg.ts";
import { bookOutputDir } from "../lib/paths.ts";
import { appendLog } from "../lib/log.ts";
import { parseFile } from "music-metadata";
import { mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { WorkerUtils } from "graphile-worker";
import { chapterChunkPreviewDir, chapterChunkPreviewUrlBase, listChapterChunkPreviews } from "../lib/chunk-previews.ts";
import { buildSyncMapFromChunks, writeSyncMap } from "../lib/sync-map.ts";

export type SynthesizePayload = {
  chapterId: string;
  bookId: string;
  resume?: boolean;
};

export async function synthesize(payload: SynthesizePayload, { addJob: _addJob }: { addJob: WorkerUtils["addJob"] }) {
  const { chapterId, bookId, resume = false } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  const [currentChapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
  if (currentChapter?.status === "suspended") {
    await log(`[Ch ${(currentChapter.index ?? 0) + 1}] Skipped (suspended)`);
    return;
  }

  const transitioned = await db
    .update(chapters)
    // On resume keep the prior progress (e.g. "313/322") until the script reports fresh numbers.
    .set({ status: "synthesizing", error: null, ...(resume ? {} : { progress: null }) })
    .where(and(eq(chapters.id, chapterId), ne(chapters.status, "suspended")))
    .returning({ id: chapters.id });

  if (transitioned.length === 0) {
    await log(`[Ch ${(currentChapter?.index ?? 0) + 1}] Skipped (suspended)`);
    return;
  }

  await db.update(books).set({ error: null, updatedAt: new Date() }).where(eq(books.id, bookId));

  let chPrefix = "";
  const chLog = (msg: string) => appendLog(bookId, chPrefix + msg);
  const abortController = new AbortController();
  let cancelPoll: NodeJS.Timeout | null = null;
  let cancelCheckInFlight = false;

  try {
    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
    if (!chapter) throw new Error(`Chapter ${chapterId} not found`);
    const text = chapter.customText ?? chapter.cleanText ?? chapter.rawText;
    if (!text) throw new Error(`Chapter ${chapterId} has no text`);

    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book) throw new Error(`Book ${bookId} not found`);

    chPrefix = `[Ch ${chapter.index + 1}] `;

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const textSource = chapter.customText ? "custom" : chapter.cleanText ? "clean" : "raw";
    await chLog(`Synthesizing "${chapter.title}" (${wordCount.toLocaleString()} words, ${textSource} text)`);

    const outDir = bookOutputDir(bookId);
    await mkdir(outDir, { recursive: true });

    const wavPath = path.join(outDir, `ch${String(chapter.index).padStart(3, "0")}.wav`);
    const m4aPath = path.join(outDir, `ch${String(chapter.index).padStart(3, "0")}.m4a`);
    const chunkPreviewDir = chapterChunkPreviewDir(bookId, chapter.index);
    const chunkPreviewUrlBase = chapterChunkPreviewUrlBase(bookId, chapter.index);
    if (resume) {
      // Keep already-synthesized chunk previews so the Python script can reuse them. Drop only the
      // last one, which may be a partial write from when the previous run was killed mid-chunk.
      await mkdir(chunkPreviewDir, { recursive: true });
      const existing = await listChapterChunkPreviews(bookId, chapter.index);
      const lastPreview = existing.at(-1);
      if (lastPreview) {
        await unlink(path.join(chunkPreviewDir, lastPreview.fileName)).catch(() => {});
      }
      await chLog(`Resuming — reusing ${Math.max(existing.length - 1, 0)} already-synthesized chunk(s)`);
    } else {
      await rm(chunkPreviewDir, { recursive: true, force: true });
      await mkdir(chunkPreviewDir, { recursive: true });
    }

    cancelPoll = setInterval(async () => {
      if (cancelCheckInFlight) return;
      cancelCheckInFlight = true;
      try {
        const [latest] = await db
          .select({ status: chapters.status })
          .from(chapters)
          .where(eq(chapters.id, chapterId));
        if (latest?.status === "suspended") {
          abortController.abort();
        }
      } finally {
        cancelCheckInFlight = false;
      }
    }, 1500);

    await ttsSynthesize({
      inputText: text,
      outputPath: wavPath,
      voice: book.voice,
      speed: book.speed,
      chunkPreviewDir,
      chunkPreviewUrlBase,
      log: chLog,
      signal: abortController.signal,
      onProgress: async (chunk, totalChunks) => {
        const updated = await db.update(chapters)
          .set({ progress: `${chunk}/${totalChunks}` })
          .where(and(eq(chapters.id, chapterId), ne(chapters.status, "suspended")))
          .returning({ id: chapters.id });
        if (updated.length === 0) {
          abortController.abort();
        }
      },
    });

    if (cancelPoll) {
      clearInterval(cancelPoll);
      cancelPoll = null;
    }

    const [latestAfterSynth] = await db
      .select({ status: chapters.status })
      .from(chapters)
      .where(eq(chapters.id, chapterId));
    if (latestAfterSynth?.status === "suspended") {
      await chLog("Stopped — cancelled by user");
      return;
    }

    await chLog(`Converting WAV to M4A`);
    await encodeToM4a(wavPath, m4aPath);

    await unlink(wavPath).catch(() => {});
    await unlink(wavPath.replace(/\.wav$/, ".txt")).catch(() => {});

    const metadata = await parseFile(m4aPath, { duration: true });
    const durationMs = Math.round((metadata.format.duration ?? 0) * 1000);

    // Persist text↔audio timings so read-along exports survive chunk-WAV cleanup;
    // if the sync map can't be built, keep the chunks so it can be rebuilt later
    const syncMap = await buildSyncMapFromChunks(chunkPreviewDir, durationMs).catch(() => null);
    if (syncMap) {
      await writeSyncMap(m4aPath, syncMap);
      await rm(chunkPreviewDir, { recursive: true, force: true }).catch(() => {});
    }

    await db
      .update(chapters)
      .set({
        audioPath: m4aPath,
        durationMs,
        status: "done",
        progress: null,
        synthesizedWith: {
          voice: book.voice,
          speed: voiceSupportsSpeed(book.voice) ? book.speed : null,
        },
      })
      .where(eq(chapters.id, chapterId));

    const totalSec = Math.round(durationMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    await chLog(`Done — ${min}:${String(sec).padStart(2, "0")}`);

    // Check if all non-suspended chapters are done
    const remaining = await db
      .select()
      .from(chapters)
      .where(and(
        eq(chapters.bookId, bookId),
        notInArray(chapters.status, ["done", "suspended"]),
      ));

    if (remaining.length === 0) {
      await log("All queued chapters synthesized");
    }
  } catch (err) {
    if (cancelPoll) {
      clearInterval(cancelPoll);
      cancelPoll = null;
    }

    if (err instanceof TtsAbortedError) {
      // Keep `progress` (e.g. "313/322") so the UI can show how far we got and offer to continue.
      await db.update(chapters).set({ status: "suspended", error: null }).where(eq(chapters.id, chapterId));
      await chLog("Stopped — cancelled by user");
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    await chLog(`Synthesis failed: ${message}`);
    await db.update(chapters).set({ status: "failed", error: message }).where(eq(chapters.id, chapterId));
    throw err;
  }
}
