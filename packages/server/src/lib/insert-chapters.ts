import { db } from "../db.ts";
import { chapters, chapterVariants, type ChapterSource } from "../schema.ts";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { appendLog } from "./log.ts";

export async function insertSuspendedChapters(
  bookId: string,
  detected: { title: string; text: string; cleanText?: string; pageStart: number | null; pageEnd: number | null; sourceBlocks: unknown; source?: ChapterSource }[],
  chapterOffset: number,
  sourceFileIndex: number | null,
) {
  for (const [i, ch] of detected.entries()) {
    const globalIndex = chapterOffset + i;
    const wordCount = ch.text.split(/\s+/).filter(Boolean).length;
    await appendLog(bookId, `Chapter ${globalIndex + 1}: "${ch.title}" (${wordCount.toLocaleString()} words)`);

    await db
      .insert(chapters)
      .values({
        bookId,
        index: globalIndex,
        title: ch.title,
        rawText: ch.text,
        ...(ch.cleanText ? { cleanText: ch.cleanText } : {}),
        pageStart: ch.pageStart,
        pageEnd: ch.pageEnd,
        sourceBlocks: ch.sourceBlocks,
        sourceFileIndex,
        ...(ch.source ? { source: ch.source } : {}),
        status: "suspended",
      });
  }
}

// Rebuild flows (re-extract, redetect, structure apply) replace extraction-derived
// chapters, but inserted ones (source-tagged: notes, urls) don't come from marker
// output and must survive. They move to the front (index 0..k-1) with audio state
// reset — their audio files are deleted along with the book output dir. Returns k,
// which callers use as the offset for newly detected chapters.
export async function resetChaptersKeepingInserted(bookId: string): Promise<number> {
  const kept = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), isNotNull(chapters.source)))
    .orderBy(asc(chapters.index));

  await db.delete(chapters).where(and(eq(chapters.bookId, bookId), isNull(chapters.source)));

  for (const [i, chapter] of kept.entries()) {
    await db
      .update(chapters)
      .set({
        index: i,
        status: "suspended",
        audioPath: null,
        durationMs: null,
        progress: null,
        error: null,
        synthesizedWith: null,
      })
      .where(eq(chapters.id, chapter.id));
  }

  if (kept.length > 0) {
    await db
      .update(chapterVariants)
      .set({
        audioStatus: null,
        audioPath: null,
        audioDurationMs: null,
        audioProgress: null,
        audioError: null,
        synthesizedWith: null,
      })
      .where(inArray(chapterVariants.chapterId, kept.map((c) => c.id)));
  }

  return kept.length;
}
