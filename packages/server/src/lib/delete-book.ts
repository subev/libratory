import path from "node:path";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { books } from "../schema.ts";
import { bookOutputDir, bookTmpDir, uploadsDir } from "./paths.ts";

export async function deleteBook(id: string) {
  const [book] = await db.select().from(books).where(eq(books.id, id));

  await db.delete(books).where(eq(books.id, id));

  if (book?.pdfPath) {
    await rm(path.dirname(book.pdfPath), { recursive: true, force: true }).catch(() => {});
  }
  // A book with no PDF can still keep its source there: an imported EPUB
  await rm(path.join(uploadsDir, id), { recursive: true, force: true }).catch(() => {});
  await rm(bookOutputDir(id), { recursive: true, force: true }).catch(() => {});
  await rm(bookTmpDir(id), { recursive: true, force: true }).catch(() => {});
}
