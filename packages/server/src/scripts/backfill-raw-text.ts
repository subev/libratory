import { db } from "../db.ts";
import { books, bookFiles } from "../schema.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { quickAddJob } from "graphile-worker";
import { env } from "../env.ts";
import path from "node:path";

const allBooks = await db.select({ id: books.id, title: books.title, filename: books.filename, pdfPath: books.pdfPath }).from(books);

let queued = 0;
for (const book of allBooks) {
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(bookFiles)
    .where(eq(bookFiles.bookId, book.id));
  const total = counted?.total ?? 0;

  if (total === 0) {
    if (!book.pdfPath) continue;
    // Same legacy backfill as the append-upload route: the original file is already extracted
    await db.insert(bookFiles).values({
      bookId: book.id,
      index: 0,
      filename: book.filename ?? path.basename(book.pdfPath),
      pdfPath: book.pdfPath,
      status: "done",
    });
  } else {
    const [uncovered] = await db
      .select({ missing: sql<number>`count(*)::int` })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, book.id), isNull(bookFiles.rawText)));
    if ((uncovered?.missing ?? 0) === 0) continue;
  }

  await quickAddJob({ connectionString: env.DATABASE_URL }, "rawExtract", { bookId: book.id }, { maxAttempts: 1 });
  console.log(`Queued rawExtract: ${book.title}`);
  queued++;
}

console.log(`Queued rawExtract for ${queued} of ${allBooks.length} book(s)`);
process.exit(0);
