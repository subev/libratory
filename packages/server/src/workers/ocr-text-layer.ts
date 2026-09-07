import type { WorkerUtils } from "graphile-worker";
import { asc, eq } from "drizzle-orm";

import { db } from "../db.ts";
import { books, bookFiles, DEFAULT_OCR_ENGINE } from "../schema.ts";
import { clearExtractAbort, registerExtractAbort } from "../lib/extract-registry.ts";
import { appendLog } from "../lib/log.ts";
import { ExtractAbortedError } from "../lib/marker.ts";
import { ensureTextLayer } from "../lib/ocr-text-layer.ts";
import { pdfHasTextLayer } from "../lib/pdf-raw-text.ts";

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
  const files = await db
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId))
    .orderBy(asc(bookFiles.index));
  const needs: { file: (typeof files)[number]; hasTextLayer?: boolean | null }[] = [];
  for (const file of files) {
    if (force && file.searchablePdfPath) needs.push({ file });
    else if (!file.searchablePdfPath) {
      const hasTextLayer = await pdfHasTextLayer(file.pdfPath);
      if (hasTextLayer === false) needs.push({ file, hasTextLayer });
    }
  }
  if (needs.length === 0) return;

  const engine = book.ocrEngine ?? DEFAULT_OCR_ENGINE;
  await db.update(books).set({ status: "extracting", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));

  const abort = registerExtractAbort(bookId);
  try {
    let written = 0;
    for (const { file, hasTextLayer } of needs) {
      const fileLog = (msg: string) => appendLog(bookId, msg, file.index);
      if (!book.ocrEngine) await fileLog(`No text layer in "${file.filename}" — reading it with Tesseract by default; change the engine under "About this book" in Extract…`);
      const produced = await ensureTextLayer({ bookId, file, engine, language: book.language, force, hasTextLayer, log: fileLog, signal: abort.signal });
      if (produced) written++;
    }

    const settled: Partial<typeof books.$inferInsert> = { status: "pending", error: null, updatedAt: new Date() };
    if (written > 0 && !book.ocrEngine) settled.ocrEngine = engine;
    await db.update(books).set(settled).where(eq(books.id, bookId));
    if (written > 0) {
      await addJob("indexBook", { bookId }, { maxAttempts: 1, jobKey: `index:${bookId}`, jobKeyMode: "replace" });
    }
  } catch (err) {
    // The cancel route already left the book where a stopped run belongs; "failed" over that reads red.
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
