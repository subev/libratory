import { bookFileOrder } from "../lib/book-file-order.ts";
import { createHash } from "node:crypto";
import type { WorkerUtils } from "graphile-worker";
import { and, asc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { books, bookFiles, bookChunks, chapters, chapterVariants, type Book, type SearchIndexJob, type NewBookChunk } from "../schema.ts";
import { chunkPagedText, chunkPlainText, pageMapFromBlocks, type ChunkDraft, type PageBlock } from "../lib/search-chunks.ts";
import { describeError } from "../lib/errors.ts";

export type IndexBookPayload = { bookId: string };

const INSERT_BATCH = 200;

export function indexSourceHash(text: string, drafts: ChunkDraft[]): string {
  return createHash("sha256").update(JSON.stringify({ version: 2, text, drafts })).digest("hex");
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
  chunk: (text: string) => ChunkDraft[];
};

async function reindexUnit(book: Book, unit: Unit): Promise<boolean> {
  const drafts = unit.text.trim() ? unit.chunk(unit.text) : [];
  const sourceHash = indexSourceHash(unit.text, drafts);
  const scope = and(eq(unit.keyColumn, unit.keyValue), eq(bookChunks.source, unit.source));
  return db.transaction(async (tx) => {
    const existing = await tx.select({
      id: bookChunks.id, seq: bookChunks.seq, text: bookChunks.text,
      sourceHash: bookChunks.sourceHash, charStart: bookChunks.charStart,
      charEnd: bookChunks.charEnd, pageStart: bookChunks.pageStart, pageEnd: bookChunks.pageEnd,
    }).from(bookChunks).where(scope);
    if (existing.length === drafts.length && existing.every((row) => {
      const draft = drafts[row.seq];
      return draft && row.sourceHash === sourceHash && row.text === draft.text &&
        row.charStart === draft.charStart && row.charEnd === draft.charEnd &&
        row.pageStart === draft.pageStart && row.pageEnd === draft.pageEnd;
    })) return false;
    const bySeq = new Map(existing.map((row) => [row.seq, row]));
    const obsolete = existing.filter((row) => drafts[row.seq]?.text !== row.text);
    if (obsolete.length) await tx.delete(bookChunks).where(inArray(bookChunks.id, obsolete.map((row) => row.id)));
    const rows: NewBookChunk[] = [];
    for (const [seq, draft] of drafts.entries()) {
      const previous = bySeq.get(seq);
      if (previous?.text === draft.text) {
        if (previous.charStart !== draft.charStart || previous.charEnd !== draft.charEnd ||
            previous.pageStart !== draft.pageStart || previous.pageEnd !== draft.pageEnd) {
          await tx.update(bookChunks).set(draft).where(eq(bookChunks.id, previous.id));
        }
      } else {
        rows.push({ bookId: book.id, profileId: book.profileId, folderId: book.folderId,
          source: unit.source, language: unit.language, seq, ...draft, sourceHash, ...unit.key });
      }
    }
    if (existing.some((row) => row.sourceHash !== sourceHash)) {
      await tx.update(bookChunks).set({ sourceHash }).where(scope);
    }
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      await tx.insert(bookChunks).values(rows.slice(i, i + INSERT_BATCH));
    }
    return true;
  });
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
      .orderBy(bookFileOrder, asc(bookFiles.index));
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
