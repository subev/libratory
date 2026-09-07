import { db } from "../db.ts";
import { bookFiles, type Book } from "../schema.ts";
import { eq, asc } from "drizzle-orm";
import { bookTmpDir } from "./paths.ts";
import { readablePdfPath } from "./pdf-raw-text.ts";
import path from "node:path";

export type MarkerSource = {
  fileIndex: number | null;
  filename: string;
  /** The searchable copy where one exists — everything downstream reads the pages, not the file. */
  pdfPath: string;
  outDir: string;
};

export async function listMarkerSources(book: Book): Promise<MarkerSource[]> {
  const files = await db
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.bookId, book.id))
    .orderBy(asc(bookFiles.index));

  if (files.length === 0) {
    // Zero files means legacy single-PDF book — unless the book is synthetic, which has no PDF at all
    if (book.kind !== "pdf" || !book.pdfPath || !book.filename) return [];
    return [{ fileIndex: null, filename: book.filename, pdfPath: book.pdfPath, outDir: bookTmpDir(book.id) }];
  }

  return files.map((f) => ({
    fileIndex: f.index,
    filename: f.filename,
    pdfPath: readablePdfPath(f),
    outDir: path.join(bookTmpDir(book.id), `file_${f.index}`),
  }));
}
