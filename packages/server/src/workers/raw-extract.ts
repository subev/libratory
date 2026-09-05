import type { WorkerUtils } from "graphile-worker";
import { db } from "../db.ts";
import { books, bookFiles } from "../schema.ts";
import { eq, asc, and, isNull, isNotNull } from "drizzle-orm";
import { extractPdfRawText, extractPdfAuthor, countWords } from "../lib/pdf-raw-text.ts";
import { appendLog } from "../lib/log.ts";
import { stat } from "node:fs/promises";

export type RawExtractPayload = {
  bookId: string;
  note?: { prompt: string; model: string };
};

export async function rawExtract(payload: RawExtractPayload, { addJob }: { addJob: WorkerUtils["addJob"] }) {
  const { bookId, note } = payload;

  const files = await db
    .select()
    .from(bookFiles)
    .where(and(eq(bookFiles.bookId, bookId), isNull(bookFiles.rawText)))
    .orderBy(asc(bookFiles.index));

  // Whatever the first PDF says about itself, once, and never over an answer someone gave by hand
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (book && !book.author && files[0]) {
    const author = await extractPdfAuthor(files[0].pdfPath);
    if (author) {
      await db.update(books).set({ author }).where(eq(books.id, bookId));
      await appendLog(bookId, `Author from the PDF: ${author}`);
    }
  }

  let extracted = 0;
  for (const file of files) {
    const text = await extractPdfRawText(file.pdfPath);
    if (text) {
      const words = countWords(text);
      await db.update(bookFiles).set({ rawText: text, rawWords: words }).where(eq(bookFiles.id, file.id));
      await appendLog(bookId, `Raw text: "${file.filename}" — ${words.toLocaleString()} words`, file.index);
      extracted++;
    } else if (!(await stat(file.pdfPath).catch(() => null))) {
      // Blaming the PDF for bytes that are not there sends the reader looking for the wrong fault
      await appendLog(bookId, `"${file.filename}" is missing from disk — remove it from the book`, file.index);
    } else {
      await appendLog(bookId, `Raw text unavailable for "${file.filename}" — PDF may be scanned or encrypted. Extract it as "Scanned PDF — needs OCR"; pages with no text layer read along a paragraph at a time rather than word by word`, file.index);
    }
  }

  if (extracted > 0) {
    await addJob("indexBook", { bookId }, { maxAttempts: 1, jobKey: `index:${bookId}`, jobKeyMode: "replace" });
  }

  if (!note) return;

  const withText = await db
    .select({ id: bookFiles.id })
    .from(bookFiles)
    .where(and(eq(bookFiles.bookId, bookId), isNotNull(bookFiles.rawText)))
    .limit(1);

  if (withText.length === 0) {
    const [book] = await db.select({ noteJob: books.noteJob }).from(books).where(eq(books.id, bookId));
    const now = new Date().toISOString();
    await db
      .update(books)
      .set({
        noteJob: {
          prompt: note.prompt,
          model: note.model,
          createdAt: book?.noteJob?.createdAt ?? now,
          ...book?.noteJob,
          status: "failed",
          error: "No raw text could be extracted",
          updatedAt: now,
        },
        updatedAt: new Date(),
      })
      .where(eq(books.id, bookId));
    await appendLog(bookId, "Skipping AI note — no raw text could be extracted from any file");
    return;
  }

  await addJob("bookNote", { bookId, prompt: note.prompt, model: note.model }, { maxAttempts: 1 });
}
