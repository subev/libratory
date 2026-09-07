import type { WorkerUtils } from "graphile-worker";
import { asc, eq } from "drizzle-orm";

import { db } from "../db.ts";
import { books, bookFiles } from "../schema.ts";
import { clearExtractAbort, registerExtractAbort } from "../lib/extract-registry.ts";
import { appendLog } from "../lib/log.ts";
import { ExtractAbortedError } from "../lib/marker.ts";
import { ensureTextLayer } from "../lib/ocr-text-layer.ts";

export type OcrTextLayerPayload = {
  bookId: string;
  force?: boolean;
};

export async function ocrTextLayer(payload: OcrTextLayerPayload, { addJob }: { addJob: WorkerUtils["addJob"] }) {
  const { bookId, force } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) throw new Error(`Book ${bookId} not found`);
  if (book.kind !== "pdf") {
    await log("Skipping OCR — synthetic books have no PDF to read");
    return;
  }
  if (book.ocrEngine === null) {
    await log("Skipping OCR — no OCR engine is set on this book");
    return;
  }

  await db.update(books).set({ status: "extracting", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));

  const abort = registerExtractAbort(bookId);
  try {
    const files = await db
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId))
      .orderBy(asc(bookFiles.index));

    let written = 0;
    for (const file of files) {
      const produced = await ensureTextLayer({
        bookId,
        file,
        engine: book.ocrEngine,
        language: book.language,
        force,
        log: (msg) => appendLog(bookId, msg, file.index),
        signal: abort.signal,
      });
      if (produced) written++;
    }

    await db.update(books).set({ status: "pending", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));
    if (written > 0) {
      await addJob("indexBook", { bookId }, { maxAttempts: 1, jobKey: `index:${bookId}`, jobKeyMode: "replace" });
    }
  } catch (err) {
    // The cancel route already put the book and its files where a stopped run belongs, and no
    // searchable copy was written — saying "failed" over that turns a deliberate stop red.
    if (err instanceof ExtractAbortedError) {
      await log("OCR cancelled");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await log(`OCR failed: ${message}`);
    await db.update(books).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(books.id, bookId));
    throw err;
  } finally {
    clearExtractAbort(bookId);
  }
}
