import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, bookFiles, chapters, assemblies } from "../schema.ts";
import { eq, asc } from "drizzle-orm";

vi.mock("../lib/marker.ts", () => ({
  redetectChaptersFromExistingMarkerOutput: vi.fn(),
}));

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../lib/paths.ts", () => ({
  bookTmpDir: (bookId: string) => `/tmp/test-${bookId}`,
  bookOutputDir: (bookId: string) => `/tmp/test-out-${bookId}`,
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { redetect } from "./redetect.ts";
import { redetectChaptersFromExistingMarkerOutput } from "../lib/marker.ts";

const mockRedetect = vi.mocked(redetectChaptersFromExistingMarkerOutput);

function fakeChapters(count: number) {
  return {
    chapters: Array.from({ length: count }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      text: `Content of chapter ${i + 1} with enough words`,
      pageStart: i * 10 + 1,
      pageEnd: (i + 1) * 10,
      sourceBlocks: [{ type: "Text", text: `Content ${i + 1}`, page: i * 10 + 1, included: true }],
    })),
    method: "numbered-headings" as const,
  };
}

describe("redetect worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockRedetect.mockReset();
  });

  it("replaces existing chapters with re-detected suspended ones", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      status: "extracting",
      totalChapters: 2,
    });
    await db.insert(chapters).values([
      { bookId, index: 0, title: "Old Preface", rawText: "old", status: "suspended" },
      { bookId, index: 1, title: "Old Chapter", rawText: "old", status: "suspended" },
    ]);
    await db.insert(assemblies).values({ bookId, outputPath: "/tmp/out.m4b", durationMs: 1000, chapterCount: 2, chapterSummary: "2 chapters", chapterIds: "a,b" });

    mockRedetect.mockResolvedValue(fakeChapters(3));

    await redetect({ bookId });

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(chs.map((c) => c.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    expect(chs.every((c) => c.status === "suspended")).toBe(true);

    const remaining = await db.select().from(assemblies).where(eq(assemblies.bookId, bookId));
    expect(remaining).toHaveLength(0);

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.status).toBe("pending");
    expect(book.totalChapters).toBe(3);
    expect(book.chapterDetection).toBe("numbered-headings");
  });

  it("re-detects each file of a multi-file book with global chapter indices", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Multi",
      filename: "part1.pdf",
      pdfPath: "/tmp/part1.pdf",
      status: "extracting",
    });
    await db.insert(bookFiles).values([
      { bookId, index: 0, filename: "part1.pdf", pdfPath: "/tmp/part1.pdf", status: "done" },
      { bookId, index: 1, filename: "part2.pdf", pdfPath: "/tmp/part2.pdf", status: "done" },
    ]);

    mockRedetect
      .mockResolvedValueOnce(fakeChapters(2))
      .mockResolvedValueOnce(fakeChapters(3));

    await redetect({ bookId });

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(chs.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    expect(chs.map((c) => c.sourceFileIndex)).toEqual([0, 0, 1, 1, 1]);
  });

  it("marks the book failed when detection finds no chapters", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Empty",
      filename: "empty.pdf",
      pdfPath: "/tmp/empty.pdf",
      status: "extracting",
    });

    mockRedetect.mockResolvedValue({ chapters: [], method: "word-split" as const });

    await expect(redetect({ bookId })).rejects.toThrow("No chapters detected");

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.status).toBe("failed");
    expect(book.error).toContain("No chapters detected");
  });
});

describe("redetect on synthetic books", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("refuses before deleting anything", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Digest", kind: "digest" });
    await db.insert(chapters).values({ bookId, index: 0, title: "Summary", rawText: "text", status: "suspended" });

    await expect(redetect({ bookId })).rejects.toThrow(/synthetic/i);

    expect(await db.select().from(chapters).where(eq(chapters.bookId, bookId))).toHaveLength(1);
  });
});
