import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, bookFiles, chapters } from "../schema.ts";
import { eq, asc } from "drizzle-orm";

// Mock external deps — extractPdf (heavy subprocess), appendLog, paths
// But use the REAL database for everything else
vi.mock("../lib/marker.ts", () => ({
  extractPdf: vi.fn(),
  ExtractAbortedError: class ExtractAbortedError extends Error {},
}));

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../lib/paths.ts", () => ({
  bookTmpDir: (bookId: string) => `/tmp/test-${bookId}`,
}));

// Redirect the db import to our test database
vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { extract } from "./extract.ts";
import { extractPdf, ExtractAbortedError } from "../lib/marker.ts";

const mockExtractPdf = vi.mocked(extractPdf);

function fakeChapters(count: number) {
  return {
    chapters: Array.from({ length: count }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      text: `Content of chapter ${i + 1} with enough words`,
      pageStart: i * 10 + 1,
      pageEnd: (i + 1) * 10,
      sourceBlocks: [{ type: "Text", text: `Content ${i + 1}`, page: i * 10 + 1, included: true }],
    })),
    method: "heading-levels" as const,
  };
}

describe("extract worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockExtractPdf.mockReset();
  });

  it("extracts a legacy book (no book_files) using book.pdfPath", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({
      id: bookId,
      title: "Legacy Book",
      filename: "legacy.pdf",
      pdfPath: "/tmp/legacy.pdf",
    });

    mockExtractPdf.mockResolvedValue(fakeChapters(3));

    await extract({ bookId }, { addJob } as any);

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(chs).toHaveLength(3);
    expect(chs.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chs.map((c) => c.sourceFileIndex)).toEqual([null, null, null]);
    expect(addJob).toHaveBeenCalledTimes(4); // normalize per chapter, plus the deferred assembly
    expect(addJob).toHaveBeenCalledWith(
      "assemble",
      { bookId, waitForAll: true },
      expect.objectContaining({ jobKey: `assemble:${bookId}:original` }),
    );

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.totalChapters).toBe(3);
  });

  it("extracts multi-file book with correct chapter ordering", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({
      id: bookId,
      title: "Multi-file Book",
      filename: "part1.pdf",
      pdfPath: "/tmp/part1.pdf",
    });

    await db.insert(bookFiles).values([
      { bookId, index: 0, filename: "part1.pdf", pdfPath: "/tmp/part1.pdf" },
      { bookId, index: 1, filename: "part2.pdf", pdfPath: "/tmp/part2.pdf" },
    ]);

    // File 0 has 2 chapters, file 1 has 3
    mockExtractPdf
      .mockResolvedValueOnce(fakeChapters(2))
      .mockResolvedValueOnce(fakeChapters(3));

    await extract({ bookId }, { addJob } as any);

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(chs).toHaveLength(5);
    // File 0 chapters get indices 0,1 — file 1 chapters get indices 2,3,4
    expect(chs.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    expect(chs.map((c) => c.sourceFileIndex)).toEqual([0, 0, 1, 1, 1]);

    // Both book_files should be marked done
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)).orderBy(asc(bookFiles.index));
    expect(files.map((f) => f.status)).toEqual(["done", "done"]);

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.totalChapters).toBe(5);
  });

  it("skips already-done files on append", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({
      id: bookId,
      title: "Append Book",
      filename: "part1.pdf",
      pdfPath: "/tmp/part1.pdf",
    });

    // File 0 already done with 2 chapters existing
    await db.insert(bookFiles).values([
      { bookId, index: 0, filename: "part1.pdf", pdfPath: "/tmp/part1.pdf", status: "done" },
      { bookId, index: 1, filename: "part2.pdf", pdfPath: "/tmp/part2.pdf", status: "pending" },
    ]);

    // Pre-existing chapters from file 0
    await db.insert(chapters).values([
      { bookId, index: 0, title: "Ch 1", rawText: "existing", sourceFileIndex: 0 },
      { bookId, index: 1, title: "Ch 2", rawText: "existing", sourceFileIndex: 0 },
    ]);

    mockExtractPdf.mockResolvedValue(fakeChapters(2));

    await extract({ bookId }, { addJob } as any);

    // extractPdf should only be called once (for file 1, not file 0)
    expect(mockExtractPdf).toHaveBeenCalledTimes(1);

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(chs).toHaveLength(4);
    // New chapters start at index 2 (after existing 0,1)
    expect(chs.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chs.map((c) => c.sourceFileIndex)).toEqual([0, 0, 1, 1]);
  });

  it("creates suspended chapters when skipSynthesis is true", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({
      id: bookId,
      title: "Reader Mode Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      skipSynthesis: true,
    });

    mockExtractPdf.mockResolvedValue(fakeChapters(2));

    await extract({ bookId }, { addJob } as any);

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId));
    expect(chs.every((c) => c.status === "suspended")).toBe(true);
    // Reader mode promises no audio, so it must not promise an M4B either
    expect(addJob).not.toHaveBeenCalled();
  });

  it("handles partial failure — one file fails, other succeeds", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({
      id: bookId,
      title: "Partial Fail",
      filename: "good.pdf",
      pdfPath: "/tmp/good.pdf",
    });

    await db.insert(bookFiles).values([
      { bookId, index: 0, filename: "good.pdf", pdfPath: "/tmp/good.pdf" },
      { bookId, index: 1, filename: "corrupt.pdf", pdfPath: "/tmp/corrupt.pdf" },
    ]);

    mockExtractPdf
      .mockResolvedValueOnce(fakeChapters(2))
      .mockRejectedValueOnce(new Error("PDF is corrupt"));

    await extract({ bookId }, { addJob } as any);

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId));
    expect(chs).toHaveLength(2); // Only from the good file

    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)).orderBy(asc(bookFiles.index));
    expect(files[0]?.status).toBe("done");
    expect(files[1]?.status).toBe("failed");
    expect(files[1]?.error).toContain("corrupt");
  });

  it("fails the whole book when all files fail", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({
      id: bookId,
      title: "All Fail",
      filename: "bad.pdf",
      pdfPath: "/tmp/bad.pdf",
    });

    await db.insert(bookFiles).values([
      { bookId, index: 0, filename: "bad1.pdf", pdfPath: "/tmp/bad1.pdf" },
      { bookId, index: 1, filename: "bad2.pdf", pdfPath: "/tmp/bad2.pdf" },
    ]);

    mockExtractPdf.mockRejectedValue(new Error("extraction failed"));

    await expect(extract({ bookId }, { addJob } as any)).rejects.toThrow();

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.status).toBe("failed");
    expect(book.error).toContain("All 2 file(s) failed");
  });

  // Cancelling the only file used to take the all-failed path, which sets books.status to "failed"
  // with a message that does not start with "Cancelled" — a red badge and a permanent "needs
  // attention" for something the user chose to stop.
  it("does not fail the book when its only file was cancelled", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({ id: bookId, title: "Stopped", filename: "a.pdf", pdfPath: "/tmp/a.pdf" });
    await db.insert(bookFiles).values([{ bookId, index: 0, filename: "a.pdf", pdfPath: "/tmp/a.pdf" }]);

    mockExtractPdf.mockRejectedValue(new ExtractAbortedError());

    await expect(extract({ bookId }, { addJob } as any)).resolves.toBeUndefined();

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.status).not.toBe("failed");
    const file = row(await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)));
    expect(file.status).toBe("suspended");
    expect(file.error).toBeNull();
  });
});
