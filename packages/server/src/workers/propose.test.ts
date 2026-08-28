import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books } from "../schema.ts";
import { eq } from "drizzle-orm";

vi.mock("../lib/marker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/marker.ts")>();
  return {
    ...actual,
    collectBlocksFromMarkerOutput: vi.fn(),
    findMarkerJson: vi.fn(async () => "/tmp/marker.json"),
  };
});

vi.mock("../lib/toc-detect.ts", () => ({
  detectChaptersWithLlm: vi.fn(),
}));

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../lib/paths.ts", () => ({
  bookTmpDir: (bookId: string) => `/tmp/test-${bookId}`,
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { propose } from "./propose.ts";
import { collectBlocksFromMarkerOutput, type FlatBlock } from "../lib/marker.ts";
import { detectChaptersWithLlm } from "../lib/toc-detect.ts";

const mockCollectBlocks = vi.mocked(collectBlocksFromMarkerOutput);
const mockLlm = vi.mocked(detectChaptersWithLlm);

function heading(text: string, page: number): FlatBlock {
  return { type: "SectionHeader", text, hierarchy: null, page, included: true };
}

const blocks = [
  heading("Chapter 1 One", 10),
  heading("Chapter 2 Two", 20),
  heading("Chapter 3 Three", 30),
];

async function insertBook(db: ReturnType<typeof getDb>) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({
    id: bookId,
    title: "Book",
    filename: "book.pdf",
    pdfPath: "/tmp/book.pdf",
    chapterProposal: { status: "running", method: "deterministic", createdAt: "2026-07-24T00:00:00.000Z" },
  });
  return bookId;
}

describe("propose worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockCollectBlocks.mockReset();
    mockLlm.mockReset();
  });

  it("stores deterministic boundaries without touching chapters", async () => {
    const db = getDb();
    const bookId = await insertBook(db);
    mockCollectBlocks.mockResolvedValue(blocks);

    await propose({ bookId, method: "deterministic" });

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.chapterProposal?.status).toBe("done");
    expect(book.chapterProposal?.detection).toBe("numbered-headings");
    expect(book.chapterProposal?.boundaries).toEqual([
      { fileIndex: null, blockIndex: 0, title: "Chapter 1 One", page: 10 },
      { fileIndex: null, blockIndex: 1, title: "Chapter 2 Two", page: 20 },
      { fileIndex: null, blockIndex: 2, title: "Chapter 3 Three", page: 30 },
    ]);
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it("stores DeepSeek-selected boundaries with cleaned and translated titles, falling back to block text", async () => {
    const db = getDb();
    const bookId = await insertBook(db);
    await db.update(books).set({ translationLanguage: "English" }).where(eq(books.id, bookId));
    mockCollectBlocks.mockResolvedValue(blocks);
    mockLlm.mockResolvedValue(
      new Map([
        [
          null,
          [
            { blockIndex: 0, title: "Глава 1", titleTranslated: "Chapter 1: One" },
            { blockIndex: 2, title: null, titleTranslated: null },
          ],
        ],
      ])
    );

    await propose({ bookId, method: "llm" });

    expect(mockLlm).toHaveBeenCalledWith(expect.anything(), expect.anything(), { translateTo: "English" });

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.chapterProposal?.status).toBe("done");
    expect(book.chapterProposal?.detection).toBe("llm");
    expect(book.chapterProposal?.boundaries).toEqual([
      { fileIndex: null, blockIndex: 0, title: "Глава 1", titleTranslated: "Chapter 1: One", page: 10 },
      { fileIndex: null, blockIndex: 2, title: "Chapter 3 Three", page: 30 },
    ]);
  });

  it("marks the proposal done with no boundaries when DeepSeek finds nothing usable", async () => {
    const db = getDb();
    const bookId = await insertBook(db);
    mockCollectBlocks.mockResolvedValue(blocks);
    mockLlm.mockResolvedValue(null);

    await propose({ bookId, method: "llm" });

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.chapterProposal?.status).toBe("done");
    expect(book.chapterProposal?.boundaries).toEqual([]);
  });

  it("marks the proposal failed when extraction output is unreadable", async () => {
    const db = getDb();
    const bookId = await insertBook(db);
    mockCollectBlocks.mockRejectedValue(new Error("no marker output"));

    await expect(propose({ bookId, method: "deterministic" })).rejects.toThrow("no marker output");

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.chapterProposal?.status).toBe("failed");
    expect(book.chapterProposal?.error).toContain("no marker output");
  });
});
