import { db } from "../db.ts";
import { chapters, books, assemblies, chapterVariants } from "../schema.ts";
import { eq, asc, and } from "drizzle-orm";
import { concatToM4b, encodeToM4a } from "../lib/ffmpeg.ts";
import { generateCover } from "../lib/cover.ts";
import { bookOutputDir } from "../lib/paths.ts";
import { appendLog } from "../lib/log.ts";
import { languageSlug } from "./synthesize-translation.ts";
import { assembleJobKey, deferUntilInputsSettle } from "../lib/output-readiness.ts";
import type { WorkerUtils } from "graphile-worker";
import { unlink } from "node:fs/promises";
import path from "node:path";

export type AssemblePayload = {
  bookId: string;
  language?: string;
  waitForAll?: boolean;
  waitingSince?: string;
};

export async function assemble(
  payload: AssemblePayload,
  { addJob }: { addJob: WorkerUtils["addJob"] },
) {
  const { bookId, language } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  if (payload.waitForAll) {
    const deferred = await deferUntilInputsSettle({
      identifier: "assemble",
      payload,
      jobKey: assembleJobKey(bookId, language),
      language,
      needs: "audio",
      addJob,
      log,
    });
    if (deferred) return;
  }

  await db.update(books).set({ status: "assembling", updatedAt: new Date() }).where(eq(books.id, bookId));
  await log(language ? `Starting assembly (${language})` : "Starting assembly");

  try {
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book) throw new Error(`Book ${bookId} not found`);

    let chaptersWithAudio: { id: string; index: number; title: string; audioPath: string; durationMs: number | null }[];
    let selectedCount: number;

    if (language) {
      const rows = await db
        .select({
          id: chapters.id,
          index: chapters.index,
          title: chapters.title,
          audioPath: chapterVariants.audioPath,
          durationMs: chapterVariants.audioDurationMs,
          audioStatus: chapterVariants.audioStatus,
        })
        .from(chapterVariants)
        .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
        .where(and(
          eq(chapters.bookId, bookId),
          eq(chapters.selected, true),
          eq(chapterVariants.key, language),
        ))
        .orderBy(asc(chapters.index));
      selectedCount = rows.length;
      chaptersWithAudio = rows
        .filter((r) => r.audioPath && r.audioStatus === "done")
        .map((r) => ({ id: r.id, index: r.index, title: r.title, audioPath: r.audioPath!, durationMs: r.durationMs }));
    } else {
      const selectedChapters = await db
        .select()
        .from(chapters)
        .where(and(eq(chapters.bookId, bookId), eq(chapters.selected, true)))
        .orderBy(asc(chapters.index));
      selectedCount = selectedChapters.length;
      chaptersWithAudio = selectedChapters
        .filter((ch) => ch.audioPath && ch.status === "done")
        .map((ch) => ({ id: ch.id, index: ch.index, title: ch.title, audioPath: ch.audioPath!, durationMs: ch.durationMs }));
    }

    if (chaptersWithAudio.length === 0) {
      // A deferred assembly was queued before the audio existed; if none ever arrived
      // that is the synthesis's failure to report, not the assembly's
      if (payload.waitForAll) {
        await log("Nothing to assemble — no selected chapter finished with audio");
        await db.update(books).set({ status: "done", updatedAt: new Date() }).where(eq(books.id, bookId));
        return;
      }
      throw new Error(language
        ? `No selected chapters with ${language} audio available for assembly`
        : "No selected chapters with audio available for assembly");
    }

    await log(`${chaptersWithAudio.length} of ${selectedCount} selected chapter${selectedCount !== 1 ? "s" : ""} have audio`);

    const outDir = bookOutputDir(bookId);
    const timestamp = formatTimestamp(new Date());
    const suffix = language ? `_${languageSlug(language)}` : "";
    const outputPath = path.join(outDir, `${sanitizeFilename(book.title)}${suffix}_${timestamp}.m4b`);

    // Chapters synthesized before the AAC switch are MP3 — re-encode those to the
    // pinned stream shape so the whole book can be stitched without transcoding
    const tempPaths: string[] = [];
    const m4aPaths: string[] = [];
    for (const ch of chaptersWithAudio) {
      if (ch.audioPath.endsWith(".m4a")) {
        m4aPaths.push(ch.audioPath);
        continue;
      }
      const tempPath = ch.audioPath.replace(/\.[^./]+$/, "") + ".assemble.m4a";
      await encodeToM4a(ch.audioPath, tempPath);
      m4aPaths.push(tempPath);
      tempPaths.push(tempPath);
    }
    if (tempPaths.length > 0) {
      await log(`Re-encoded ${tempPaths.length} legacy MP3 chapter(s) to AAC`);
    }

    let offsetMs = 0;
    const chapterMetas = chaptersWithAudio.map((ch) => {
      const startMs = offsetMs;
      const endMs = offsetMs + (ch.durationMs ?? 0);
      offsetMs = endMs;
      return { title: ch.title, startMs, endMs };
    });

    const coverPath = outputPath + ".cover.jpg";
    const hasCover = await generateCover(coverPath, book.title);

    try {
      await log(`Assembling ${m4aPaths.length} chapter(s) into M4B with chapter markers`);
      await concatToM4b(m4aPaths, outputPath, {
        title: book.title,
        artist: "Libratory",
        chapters: chapterMetas,
        ...(hasCover ? { coverPath } : {}),
      });
    } finally {
      await unlink(coverPath).catch(() => {});
      for (const p of tempPaths) {
        await unlink(p).catch(() => {});
      }
    }

    const durationMs = offsetMs;
    const totalSec = Math.round(durationMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    await log(`Assembly complete — ${min}:${String(sec).padStart(2, "0")} total duration`);

    const chapterIds = chaptersWithAudio.map((ch) => ch.id);
    const chapterSummary = buildChapterSummary(chaptersWithAudio.map((ch) => ch.index));

    await db.insert(assemblies).values({
      bookId,
      language: language ?? null,
      outputPath,
      durationMs,
      chapterCount: chaptersWithAudio.length,
      chapterSummary,
      chapterIds: JSON.stringify(chapterIds),
    });

    // books.outputPath tracks the latest original-language output; language assemblies live in their rows
    await db
      .update(books)
      .set({ status: "done", error: null, updatedAt: new Date(), ...(language ? {} : { outputPath }) })
      .where(eq(books.id, bookId));

    await log("Done!");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`Assembly failed: ${message}`);
    await db.update(books).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(books.id, bookId));
    throw err;
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100) || "audiobook";
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}_${h}${mi}${s}`;
}

// Build a compact summary like "Ch 1-3, 5, 7-10" from 0-based indices
function buildChapterSummary(indices: number[]): string {
  const [head, ...rest] = indices.map((i) => i + 1).sort((a, b) => a - b);
  if (head === undefined) return "";
  const ranges: string[] = [];
  let start = head;
  let end = head;
  for (const num of rest) {
    if (num === end + 1) {
      end = num;
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = num;
      end = num;
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return `Ch ${ranges.join(", ")}`;
}
