import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, bookFiles, chapters, notes } from "../schema.ts";
import { eq, asc } from "drizzle-orm";

const { mockDeepseekChat, mockEnv } = vi.hoisted(() => ({
  mockDeepseekChat: vi.fn(async (..._args: unknown[]) => "Spoken summary."),
  mockEnv: { DEEPSEEK_API_KEY: "test-key" as string | undefined, DATA_DIR: "/nonexistent" },
}));

vi.mock("../lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/llm.ts")>();
  return { ...actual, llmChat: mockDeepseekChat };
});

vi.mock("../env.ts", () => ({ env: mockEnv }));

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { digest } from "./digest.ts";

async function insertSourceBook(opts: { title: string; rawText?: string | null; chapterText?: string }) {
  const db = getDb();
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: opts.title, filename: "s.pdf", pdfPath: "/tmp/s.pdf" });
  await db.insert(bookFiles).values({
    bookId,
    index: 0,
    filename: "s.pdf",
    pdfPath: "/tmp/s.pdf",
    status: "raw",
    rawText: opts.rawText ?? null,
  });
  if (opts.chapterText) {
    await db.insert(chapters).values({ bookId, index: 0, title: "Ch 1", rawText: "raw ch", cleanText: opts.chapterText });
  }
  return bookId;
}

async function insertDigestBook(sourceBookIds: string[], prompt = "Narrate a summary") {
  const db = getDb();
  const now = new Date().toISOString();
  const book = row(await db
    .insert(books)
    .values({
      title: "My Digest",
      kind: "digest",
      skipSynthesis: true,
      origin: { type: "digest", sourceBookIds, prompt, model: "flash" },
      digestJob: { status: "running", createdAt: now, updatedAt: now },
    })
    .returning());
  return book.id;
}

describe("digest worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockDeepseekChat.mockReset();
    mockDeepseekChat.mockResolvedValue("Spoken summary.");
    mockEnv.DEEPSEEK_API_KEY = "test-key";
  });

  it("creates one suspended chapter per source with source links and notes on the sources", async () => {
    const db = getDb();
    const a = await insertSourceBook({ title: "Book A", rawText: "A raw text" });
    const b = await insertSourceBook({ title: "Book B", rawText: "B raw text" });
    const digestId = await insertDigestBook([a, b]);

    await digest({ bookId: digestId });

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, digestId)).orderBy(asc(chapters.index));
    expect(chs.map((c) => c.title)).toEqual(["Book A", "Book B"]);
    expect(chs.every((c) => c.status === "suspended" && c.rawText === "Spoken summary.")).toBe(true);
    expect(chs[0]?.source).toEqual({ kind: "book", bookId: a, title: "Book A" });

    const noteRows = await db.select().from(notes);
    expect(noteRows.map((n) => n.bookId).sort()).toEqual([a, b].sort());
    expect(noteRows[0]?.scope).toMatchObject({ kind: "book-raw", digestBookId: digestId });

    const book = row(await db.select().from(books).where(eq(books.id, digestId)));
    expect(book.digestJob?.status).toBe("done");
    expect(book.totalChapters).toBe(2);
    expect(book.status).toBe("pending");
  });

  it("prefers chapter text over raw text", async () => {
    const a = await insertSourceBook({ title: "Extracted", rawText: "raw layer", chapterText: "cleaned chapter text" });
    const b = await insertSourceBook({ title: "Raw only", rawText: "raw only text" });
    const digestId = await insertDigestBook([a, b]);

    await digest({ bookId: digestId });

    const firstCall = mockDeepseekChat.mock.calls[0]?.[1] as string;
    const secondCall = mockDeepseekChat.mock.calls[1]?.[1] as string;
    expect(firstCall).toContain("cleaned chapter text");
    expect(firstCall).not.toContain("raw layer");
    expect(secondCall).toContain("raw only text");
  });

  it("resumes idempotently, skipping sources that already have chapters", async () => {
    const db = getDb();
    const a = await insertSourceBook({ title: "Book A", rawText: "A" });
    const b = await insertSourceBook({ title: "Book B", rawText: "B" });
    const digestId = await insertDigestBook([a, b]);
    await db.insert(chapters).values({
      bookId: digestId,
      index: 0,
      title: "Book A",
      rawText: "existing summary",
      status: "suspended",
      source: { kind: "book", bookId: a, title: "Book A" },
    });

    await digest({ bookId: digestId });

    expect(mockDeepseekChat).toHaveBeenCalledTimes(1);
    const chs = await db.select().from(chapters).where(eq(chapters.bookId, digestId)).orderBy(asc(chapters.index));
    expect(chs.map((c) => c.title)).toEqual(["Book A", "Book B"]);
    expect(chs[0]?.rawText).toBe("existing summary");
  });

  it("skips textless sources and reports partial failure", async () => {
    const db = getDb();
    const a = await insertSourceBook({ title: "Good", rawText: "text" });
    const b = await insertSourceBook({ title: "Scanned", rawText: null });
    const digestId = await insertDigestBook([a, b]);

    await digest({ bookId: digestId });

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, digestId));
    expect(chs).toHaveLength(1);
    const book = row(await db.select().from(books).where(eq(books.id, digestId)));
    expect(book.digestJob?.status).toBe("failed");
    expect(book.digestJob?.error).toMatch(/1 of 2/);
  });

  it("fails the job when the API key is missing", async () => {
    const a = await insertSourceBook({ title: "A", rawText: "text" });
    const b = await insertSourceBook({ title: "B", rawText: "text" });
    const digestId = await insertDigestBook([a, b]);
    mockEnv.DEEPSEEK_API_KEY = undefined;

    await expect(digest({ bookId: digestId })).rejects.toThrow(/DEEPSEEK_API_KEY/);

    const db = getDb();
    const book = row(await db.select().from(books).where(eq(books.id, digestId)));
    expect(book.digestJob?.status).toBe("failed");
    expect(mockDeepseekChat).not.toHaveBeenCalled();
  });

  it("continues past a DeepSeek failure on one source", async () => {
    const db = getDb();
    const a = await insertSourceBook({ title: "Fails", rawText: "text" });
    const b = await insertSourceBook({ title: "Works", rawText: "text" });
    const digestId = await insertDigestBook([a, b]);
    mockDeepseekChat.mockRejectedValueOnce(new Error("DeepSeek API error 500")).mockResolvedValueOnce("Summary B");

    await digest({ bookId: digestId });

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, digestId));
    expect(chs.map((c) => c.title)).toEqual(["Works"]);
    const book = row(await db.select().from(books).where(eq(books.id, digestId)));
    expect(book.digestJob?.status).toBe("failed");
  });
});
