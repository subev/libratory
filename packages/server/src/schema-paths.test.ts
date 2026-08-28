import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb, resetDb, row } from "../test/setup.ts";
import { books, bookFiles, chapters } from "./schema.ts";
import { outputDir, uploadsDir } from "./lib/paths.ts";

// The seam is the column, so the only honest place to check it is a round trip through Postgres:
// absolute going in, relative on disk, absolute coming back.
describe("the data-path columns", () => {
  beforeEach(async () => { await resetDb(getDb()); });

  async function insertBook(pdfPath: string, audioPath: string) {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath });
    await db.insert(bookFiles).values({ bookId, index: 0, filename: "b.pdf", pdfPath });
    await db.insert(chapters).values({ bookId, index: 0, title: "One", rawText: "t", audioPath });
    return bookId;
  }

  it("stores a path under the data dir without the part that is this machine", async () => {
    const db = getDb();
    const pdfPath = path.join(uploadsDir, "b-1", "book.pdf");
    const audioPath = path.join(outputDir, "b-1", "ch000.m4a");
    const bookId = await insertBook(pdfPath, audioPath);

    const raw = await db.execute(sql`select pdf_path from ${bookFiles} where book_id = ${bookId}`);
    expect((raw as unknown as { pdf_path: string }[])[0]?.pdf_path).toBe(path.join("uploads", "b-1", "book.pdf"));

    const file = row(await db.select().from(bookFiles));
    const chapter = row(await db.select().from(chapters));
    expect(file.pdfPath).toBe(pdfPath);
    expect(chapter.audioPath).toBe(audioPath);
  });

  // Rows written before the columns were relative, and files a user points at from elsewhere
  it("leaves a path outside the data dir alone in both directions", async () => {
    const db = getDb();
    const outside = "/elsewhere/on/disk/book.pdf";
    const bookId = await insertBook(outside, outside);

    const raw = await db.execute(sql`select pdf_path from ${bookFiles} where book_id = ${bookId}`);
    expect((raw as unknown as { pdf_path: string }[])[0]?.pdf_path).toBe(outside);

    const file = row(await db.select().from(bookFiles));
    expect(file.pdfPath).toBe(outside);
  });

  it("hands back null rather than the data dir for a chapter with no audio", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf" });
    await db.insert(chapters).values({ bookId, index: 0, title: "One", rawText: "t" });

    const chapter = row(await db.select().from(chapters));
    expect(chapter.audioPath).toBeNull();
  });
});
