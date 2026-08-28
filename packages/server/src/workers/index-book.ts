import { createHash } from "node:crypto";
import type { WorkerUtils } from "graphile-worker";
import { and, asc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { books, bookFiles, bookChunks, chapters, chapterVariants, type Book, type SearchIndexJob, type NewBookChunk } from "../schema.ts";
import { chunkPagedText, chunkPlainText, pageMapFromBlocks, type ChunkDraft, type PageBlock } from "../lib/search-chunks.ts";
import { describeError } from "../lib/errors.ts";

export type IndexBookPayload = { bookId: string };

const INSERT_BATCH = 200;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function setJob(bookId: string, current: SearchIndexJob | null, partial: Partial<SearchIndexJob>): Promise<SearchIndexJob> {
  const job: SearchIndexJob = {
    status: "queued",
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  await db.update(books).set({ searchIndex: job }).where(eq(books.id, bookId));
  return job;
}

type Unit = {
  key: Partial<Pick<NewBookChunk, "bookFileId" | "chapterId" | "translationId">>;
  keyColumn: typeof bookChunks.bookFileId | typeof bookChunks.chapterId | typeof bookChunks.translationId;
  keyValue: string;
  source: "raw" | "chapter" | "translation";
  language: string | null;
  text: string;
  // Distinguishes chunkings of the same text (e.g. block-mapped pages) so the
  // unit reindexes once when the chunking gains information
  hashSalt?: string;
  chunk: (text: string) => ChunkDraft[];
};

async function reindexUnit(book: Book, unit: Unit): Promise<boolean> {
  const sourceHash = hash((unit.hashSalt ?? "") + unit.text);
  const [existing] = await db
    .select({ sourceHash: bookChunks.sourceHash })
    .from(bookChunks)
    .where(eq(unit.keyColumn, unit.keyValue))
    .limit(1);
  if (existing?.sourceHash === sourceHash) return false;

  const drafts = unit.text.trim() ? unit.chunk(unit.text) : [];
  const rows: NewBookChunk[] = drafts.map((d, seq) => ({
    bookId: book.id,
    profileId: book.profileId,
    folderId: book.folderId,
    source: unit.source,
    language: unit.language,
    seq,
    text: d.text,
    charStart: d.charStart,
    charEnd: d.charEnd,
    pageStart: d.pageStart,
    pageEnd: d.pageEnd,
    sourceHash,
    ...unit.key,
  }));

  await db.transaction(async (tx) => {
    await tx.delete(bookChunks).where(eq(unit.keyColumn, unit.keyValue));
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      await tx.insert(bookChunks).values(rows.slice(i, i + INSERT_BATCH));
    }
  });
  return true;
}

export async function indexBook({ bookId }: IndexBookPayload, { addJob }: { addJob: WorkerUtils["addJob"] }) {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return;
  let job = await setJob(bookId, book.searchIndex ?? null, { status: "chunking", error: undefined });

  try {
    const units: Unit[] = [];

    const files = await db
      .select()
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, bookId), isNotNull(bookFiles.rawText)))
      .orderBy(asc(bookFiles.index));
    for (const file of files) {
      units.push({
        key: { bookFileId: file.id },
        keyColumn: bookChunks.bookFileId,
        keyValue: file.id,
        source: "raw",
        language: null,
        text: file.rawText ?? "",
        chunk: chunkPagedText,
      });
    }

    const chapterRows = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    for (const ch of chapterRows) {
      const text = ch.customText ?? ch.cleanText ?? ch.rawText;
      const blocks = Array.isArray(ch.sourceBlocks) ? (ch.sourceBlocks as PageBlock[]) : null;
      const pageOf = blocks ? pageMapFromBlocks(text, blocks) : null;
      units.push({
        key: { chapterId: ch.id },
        keyColumn: bookChunks.chapterId,
        keyValue: ch.id,
        source: "chapter",
        language: null,
        text,
        hashSalt: pageOf ? "pages:v1\n" : undefined,
        chunk: (t) => chunkPlainText(t, ch.pageStart, ch.pageEnd, pageOf),
      });
    }

    const translations = await db
      .select({ translation: chapterVariants, chapter: chapters })
      .from(chapterVariants)
      .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
      .where(and(eq(chapters.bookId, bookId), eq(chapterVariants.status, "done")));
    for (const { translation, chapter } of translations) {
      units.push({
        key: { translationId: translation.id, chapterId: translation.chapterId },
        keyColumn: bookChunks.translationId,
        keyValue: translation.id,
        source: "translation",
        language: translation.key,
        text: translation.text,
        chunk: (text) => chunkPlainText(text, chapter.pageStart, chapter.pageEnd),
      });
    }

    let changed = 0;
    for (const [i, unit] of units.entries()) {
      if (await reindexUnit(book, unit)) changed++;
      if ((i + 1) % 5 === 0 || i === units.length - 1) {
        job = await setJob(bookId, job, { progress: `chunked ${i + 1}/${units.length} units` });
      }
    }

    // Books move between folders/profiles without re-chunking
    await db
      .update(bookChunks)
      .set({ profileId: book.profileId, folderId: book.folderId })
      .where(and(
        eq(bookChunks.bookId, bookId),
        or(
          ne(bookChunks.profileId, book.profileId),
          book.folderId === null ? isNotNull(bookChunks.folderId) : sql`${bookChunks.folderId} is distinct from ${book.folderId}`,
        ),
      ));

    job = await setJob(bookId, job, { status: "embedding", progress: `chunked ${units.length} units (${changed} changed)` });
    await addJob("embedChunks", { bookId }, { maxAttempts: 1, jobKey: `embed:${bookId}`, jobKeyMode: "replace" });
  } catch (err) {
    await setJob(bookId, job, { status: "failed", error: describeError(err) });
    throw err;
  }
}
