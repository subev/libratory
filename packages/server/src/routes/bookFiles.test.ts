import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb, resetDb, row } from "../../test/setup.ts";
import { bookFiles, books, chapters } from "../schema.ts";
import { eq } from "drizzle-orm";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("graphile-worker", () => ({ quickAddJob: vi.fn(async () => {}) }));

import { bookFilesRouter } from "./bookFiles.ts";

const caller = bookFilesRouter.createCaller({});

async function twoFileBook() {
  const db = getDb();
  const book = row(await db
    .insert(books)
    .values({ title: "Two volumes", filename: "one.pdf", pdfPath: "/uploads/00_one.pdf" })
    .returning());
  const rows = await db
    .insert(bookFiles)
    .values([
      { bookId: book.id, index: 0, filename: "one.pdf", pdfPath: "/uploads/00_one.pdf", status: "done" },
      { bookId: book.id, index: 1, filename: "two.pdf", pdfPath: "/uploads/01_two.pdf", status: "done" },
    ])
    .returning();
  return { book, rows };
}

async function bookRow(id: string) {
  return row(await getDb().select().from(books).where(eq(books.id, id)));
}

beforeEach(async () => {
  await resetDb(getDb());
});

// books.pdfPath is the pre-book_files original, and the add-a-file route reads it as "the book's
// only PDF" whenever no rows remain. Left describing a deleted file, it puts that file back.
describe("removing a file keeps books.pdfPath describing a file that is still there", () => {
  it("follows on to the next file when the one it named is removed", async () => {
    const { book, rows } = await twoFileBook();

    await caller.remove({ id: row(rows).id });

    expect(await bookRow(book.id)).toMatchObject({ pdfPath: "/uploads/01_two.pdf", filename: "two.pdf" });
  });

  it("leaves nothing behind to restore once the last file is removed", async () => {
    const { book, rows } = await twoFileBook();

    await caller.remove({ id: row(rows).id });
    await caller.remove({ id: row(rows, 1).id });

    expect(await bookRow(book.id)).toMatchObject({ pdfPath: null, filename: null });
    expect(await getDb().select().from(bookFiles).where(eq(bookFiles.bookId, book.id))).toEqual([]);
  });

  it("is untouched when a file other than the named one goes", async () => {
    const { book, rows } = await twoFileBook();

    await caller.remove({ id: row(rows, 1).id });

    expect(await bookRow(book.id)).toMatchObject({ pdfPath: "/uploads/00_one.pdf", filename: "one.pdf" });
  });
});

// Re-extraction deletes a file's chapters, its audio and any text edited by hand. The guard that
// refuses while chapters are synthesizing ran inside the same loop that deletes, so selecting two
// files where only the second was busy destroyed the first one's work and then threw — a request
// that queued nothing and still cost you a chapter.
describe("refusing to re-extract does not consume the files it got to first", () => {
  async function selectedBookWithChapters(secondFileStatus: "done" | "synthesizing") {
    const db = getDb();
    const { book, rows } = await twoFileBook();
    await db.update(bookFiles).set({ selected: true }).where(eq(bookFiles.bookId, book.id));
    await db.insert(chapters).values([
      { bookId: book.id, sourceFileIndex: 0, index: 0, title: "Kept", rawText: "one", status: "done" as const },
      { bookId: book.id, sourceFileIndex: 1, index: 1, title: "Busy", rawText: "two", status: secondFileStatus },
    ]);
    return { book, rows };
  }

  it("keeps the first file's chapters when a later one is mid-synthesis", async () => {
    const { book } = await selectedBookWithChapters("synthesizing");

    await expect(caller.reExtractSelected({ bookId: book.id })).rejects.toThrow(/actively processing/);

    const left = await getDb().select().from(chapters).where(eq(chapters.bookId, book.id));
    expect(left).toHaveLength(2);
    // And nothing was half-started either
    const files = await getDb().select().from(bookFiles).where(eq(bookFiles.bookId, book.id));
    expect(files.every((f) => f.status === "done")).toBe(true);
  });

  it("still clears everything when no file is busy", async () => {
    const { book } = await selectedBookWithChapters("done");

    await caller.reExtractSelected({ bookId: book.id });

    expect(await getDb().select().from(chapters).where(eq(chapters.bookId, book.id))).toEqual([]);
  });
});
