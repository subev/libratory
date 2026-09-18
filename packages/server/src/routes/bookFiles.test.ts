import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb, resetDb, row } from "../../test/setup.ts";
import { bookFiles, books, chapters } from "../schema.ts";
import { eq } from "drizzle-orm";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bookFileOutDir, bookTmpDir } from "../lib/paths.ts";
import { bookFileOrder } from "../lib/book-file-order.ts";
import { getBookRawText } from "../lib/book-raw-text.ts";
import { listMarkerSources } from "../lib/marker-sources.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("graphile-worker", () => ({ quickAddJob: vi.fn(async () => {}) }));

import { bookFilesRouter } from "./bookFiles.ts";
import { quickAddJob } from "graphile-worker";

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
  vi.mocked(quickAddJob).mockClear();
});

describe("resuming saved AI pages", () => {
  it("queues only chosen failed files without deleting completed chapters or checkpoints", async () => {
    const { book, rows } = await twoFileBook();
    const db = getDb();
    const failed = row(rows, 1);
    await db.update(books).set({ status: "suspended", ocrEngine: "llm" }).where(eq(books.id, book.id));
    await db.update(bookFiles).set({ status: "failed" }).where(eq(bookFiles.id, failed.id));
    const chapter = row(await db.insert(chapters).values({ bookId: book.id, index: 0, sourceFileIndex: 0, title: "Keep", rawText: "Original", customText: "Edited", status: "suspended" }).returning());
    const outDir = bookFileOutDir(book.id, failed.index);
    await mkdir(outDir, { recursive: true });
    const saved = JSON.stringify({ complete: false, pages: [{ blocks: [] }, null] });
    await writeFile(path.join(outDir, "llm-pages.json"), saved);
    await expect(caller.resumeExtraction({ bookId: book.id, files: [{ id: failed.id, routing: "prose" }], repairLimit: 51 })).rejects.toThrow();
    expect(quickAddJob).not.toHaveBeenCalled();
    await caller.resumeExtraction({ bookId: book.id, files: [{ id: failed.id, routing: "prose" }], repairLimit: 5 });
    expect(row(await db.select().from(chapters).where(eq(chapters.id, chapter.id))).customText).toBe("Edited");
    expect(await readFile(path.join(outDir, "llm-pages.json"), "utf8")).toBe(saved);
    expect((await bookRow(book.id)).extractionSettings?.fileRouting?.[failed.id]).toBe("prose");
    expect(row(await db.select().from(bookFiles).where(eq(bookFiles.id, failed.id))).status).toBe("pending");
    expect(quickAddJob).toHaveBeenCalledWith(expect.anything(), "extract", { bookId: book.id, repairLimit: 5 }, expect.objectContaining({ maxAttempts: 1 }));
  });

  it("refuses to change settings during a running job or replace chapters through resume", async () => {
    const { book, rows } = await twoFileBook();
    const db = getDb();
    const file = row(rows, 1);
    const input = { bookId: book.id, files: [{ id: file.id, routing: "auto" as const }] };
    await db.update(books).set({ status: "extracting", ocrEngine: "llm" }).where(eq(books.id, book.id));
    await db.update(bookFiles).set({ status: "failed" }).where(eq(bookFiles.id, file.id));
    await expect(caller.resumeExtraction(input)).rejects.toThrow("running extraction");
    await db.update(books).set({ status: "suspended" }).where(eq(books.id, book.id));
    await db.insert(chapters).values({ bookId: book.id, index: 0, sourceFileIndex: file.index, title: "Keep", rawText: "Original", status: "suspended" });
    await expect(caller.resumeExtraction(input)).rejects.toThrow("already has chapters");
    expect(quickAddJob).not.toHaveBeenCalled();
    expect((await bookRow(book.id)).extractionSettings).toBeNull();
  });
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

describe("source file order is independent of extraction identity", () => {
  it("reorders sources and raw text without changing chapters, PDFs or paid caches", async () => {
    const db = getDb();
    const { book, rows } = await twoFileBook();
    const first = row(rows);
    const second = row(rows, 1);
    await db.update(bookFiles).set({ index: 7, searchablePdfPath: "/uploads/one.ocr.pdf", rawText: "first text" }).where(eq(bookFiles.id, first.id));
    await db.update(bookFiles).set({ index: 12, searchablePdfPath: "/uploads/two.ocr.pdf", rawText: "second text" }).where(eq(bookFiles.id, second.id));
    await db.insert(chapters).values({ bookId: book.id, index: 0, sourceFileIndex: 7, title: "Kept", rawText: "verse\nverse", customText: "edited", audioPath: "/tmp/kept.m4a", status: "done" });
    const before = await db.select().from(chapters).where(eq(chapters.bookId, book.id));
    const filesBefore = await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id));
    const cache = path.join(bookFileOutDir(book.id, 7), "llm-pages.json");
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, "paid page results");
    try {
      await caller.reorder({ bookId: book.id, fileIds: [second.id, first.id] });
      const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id)).orderBy(bookFileOrder);
      expect(files.map((file) => [file.id, file.index, file.position])).toEqual([[second.id, 12, 0], [first.id, 7, 1]]);
      for (const file of files) expect(file).toEqual({ ...filesBefore.find((old) => old.id === file.id), position: file.position });
      expect(await db.select().from(chapters).where(eq(chapters.bookId, book.id))).toEqual(before);
      expect(await readFile(cache, "utf8")).toBe("paid page results");
      expect(await bookRow(book.id)).toMatchObject({ filename: "two.pdf", pdfPath: "/uploads/01_two.pdf" });
      expect((await listMarkerSources(await bookRow(book.id))).map((source) => source.fileIndex)).toEqual([12, 7]);
      const raw = await getBookRawText(book.id);
      expect(raw?.text.indexOf("second text")).toBeLessThan(raw?.text.indexOf("first text") ?? 0);
      expect(quickAddJob).not.toHaveBeenCalled();
    } finally {
      await rm(bookTmpDir(book.id), { recursive: true, force: true });
    }
  });

  it.each(["duplicate", "missing", "foreign", "extracting"])("rejects %s reorder requests without partial changes", async (scenario) => {
    const db = getDb();
    const { book, rows } = await twoFileBook();
    const first = row(rows);
    const second = row(rows, 1);
    if (scenario === "extracting") await db.update(bookFiles).set({ status: "extracting" }).where(eq(bookFiles.id, second.id));
    const before = await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id));
    const fileIds = scenario === "duplicate" ? [first.id, first.id] : scenario === "missing" ? [first.id] : scenario === "foreign" ? [first.id, crypto.randomUUID()] : [second.id, first.id];
    await expect(caller.reorder({ bookId: book.id, fileIds })).rejects.toThrow();
    expect(await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id))).toEqual(before);
    expect(quickAddJob).not.toHaveBeenCalled();
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

  it.each(["failed", "suspended"] as const)("retains a %s file's saved transcription for retry", async (status) => {
    const { book, rows } = await selectedBookWithChapters("done");
    await getDb().update(bookFiles).set({ status }).where(eq(bookFiles.id, row(rows).id));
    const outDir = bookFileOutDir(book.id, 0);
    const saved = path.join(outDir, "llm-pages.json");
    await mkdir(outDir, { recursive: true });
    await writeFile(saved, "paid transcription");
    try {
      await caller.reExtractSelected({ bookId: book.id, ignoreTextLayer: true });
      expect(await readFile(saved, "utf-8")).toBe("paid transcription");
    } finally {
      await rm(bookTmpDir(book.id), { recursive: true, force: true });
    }
  });

  it("limits forced OCR to the selected files and preserves the other chapters", async () => {
    const { book, rows } = await selectedBookWithChapters("done");
    const selected = row(rows);
    await getDb().update(bookFiles).set({ selected: false }).where(eq(bookFiles.id, row(rows, 1).id));

    await caller.reExtractSelected({ bookId: book.id, ignoreTextLayer: true });

    expect(quickAddJob).toHaveBeenCalledWith(expect.anything(), "extract", {
      bookId: book.id, ignoreTextLayerFileIds: [selected.id],
    }, expect.objectContaining({ maxAttempts: 1 }));
    const remaining = await getDb().select().from(chapters).where(eq(chapters.bookId, book.id));
    expect(remaining.map((ch) => ch.sourceFileIndex)).toEqual([1]);
  });
});
