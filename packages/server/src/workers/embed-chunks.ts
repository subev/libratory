import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { books, bookChunks, type SearchIndexJob } from "../schema.ts";
import { embedTexts } from "../lib/embeddings.ts";
import { describeError } from "../lib/errors.ts";
import { bundleInstalled } from "../lib/model-bundles.ts";

export type EmbedChunksPayload = { bookId: string };

const BATCH_SIZE = 32;

async function setJob(bookId: string, partial: Partial<SearchIndexJob>) {
  const [book] = await db.select({ searchIndex: books.searchIndex }).from(books).where(eq(books.id, bookId));
  if (!book) return;
  await db
    .update(books)
    .set({ searchIndex: { status: "embedding", ...book.searchIndex, ...partial, updatedAt: new Date().toISOString() } })
    .where(eq(books.id, bookId));
}

export async function embedChunks({ bookId }: EmbedChunksPayload) {
  // The embedding models are an optional 4.2 GB download, and dropping a book in before fetching
  // them is an ordinary thing to do. Asking Python anyway gets HF_HUB_OFFLINE=1 and a traceback,
  // which reached the library as a red "index failed" — a broken-looking book, for a download the
  // user has not been offered yet. Keyword search already works; this is the half that waits.
  if (!(await bundleInstalled("search"))) {
    await setJob(bookId, { status: "waiting", progress: undefined, error: undefined });
    return;
  }

  const [pending] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(bookChunks)
    .where(and(eq(bookChunks.bookId, bookId), isNull(bookChunks.embedding)));
  const total = pending?.total ?? 0;

  try {
    let done = 0;
    let batches = 0;
    while (true) {
      const rows = await db
        .select({ id: bookChunks.id, text: bookChunks.text })
        .from(bookChunks)
        .where(and(eq(bookChunks.bookId, bookId), isNull(bookChunks.embedding)))
        .orderBy(asc(bookChunks.createdAt))
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;

      const vectors = await embedTexts(rows.map((r) => r.text));
      // Short of a vector each the batch would re-select the same rows forever
      if (vectors.length !== rows.length) throw new Error("Embedding model returned fewer vectors than chunks");
      for (const [i, chunk] of rows.entries()) {
        await db.update(bookChunks).set({ embedding: vectors[i] }).where(eq(bookChunks.id, chunk.id));
      }
      done += rows.length;
      if (++batches % 5 === 0) await setJob(bookId, { progress: `embedded ${done}/${total}` });
    }
    await setJob(bookId, { status: "done", progress: undefined, error: undefined });
  } catch (err) {
    await setJob(bookId, { status: "failed", error: describeError(err) });
    throw err;
  }
}
