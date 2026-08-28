import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, chapters } from "../schema.ts";
import { asc, eq } from "drizzle-orm";

const { mockQuickAddJob } = vi.hoisted(() => ({
  mockQuickAddJob: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("graphile-worker", () => ({
  quickAddJob: mockQuickAddJob,
}));

vi.mock("./log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { createApiBook, appendApiChapters, apiBookStatus, createBookInputSchema, appendChaptersInputSchema } from "./api-books.ts";
import { DEFAULT_PROFILE_ID } from "../schema.ts";

describe("createApiBook", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockClear();
  });

  it("creates a synthetic api book with suspended, source-tagged chapters", async () => {
    const db = getDb();
    const input = createBookInputSchema.parse({
      title: "HN Top 2",
      client: "hn-top10",
      chapters: [
        { title: "Story one", text: "Chapter one text.", url: "https://example.com/one" },
        { title: "Story two", text: "Chapter two text." },
      ],
    });

    const { book, chapters: inserted } = await createApiBook(input, DEFAULT_PROFILE_ID);

    expect(book.kind).toBe("api");
    expect(book.skipSynthesis).toBe(true);
    expect(book.origin).toEqual({ type: "api", client: "hn-top10" });
    expect(inserted.map((c) => c.title)).toEqual(["Story one", "Story two"]);

    const rows = await db.select().from(chapters).where(eq(chapters.bookId, book.id)).orderBy(asc(chapters.index));
    expect(rows.map((r) => r.status)).toEqual(["suspended", "suspended"]);
    expect(rows[0]?.cleanText).toBe("Chapter one text.");
    expect(rows[0]?.source).toEqual({ kind: "url", url: "https://example.com/one", title: "Story one" });
    expect(rows[1]?.source).toEqual({ kind: "api", client: "hn-top10" });

    expect(mockQuickAddJob).toHaveBeenCalledTimes(1);
    expect(mockQuickAddJob.mock.calls[0]?.[1]).toBe("indexBook");
  });

  it("queues synthesize directly when synthesize is set — chapters are pre-normalized", async () => {
    const db = getDb();
    const input = createBookInputSchema.parse({
      title: "HN",
      synthesize: true,
      chapters: [{ title: "A", text: "a" }, { title: "B", text: "b" }],
    });

    const { book } = await createApiBook(input, DEFAULT_PROFILE_ID);

    const rows = await db.select().from(chapters).where(eq(chapters.bookId, book.id));
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(rows.every((r) => r.cleanText !== null)).toBe(true);
    const synthesizeCalls = mockQuickAddJob.mock.calls.filter((c) => c[1] === "synthesize");
    expect(synthesizeCalls).toHaveLength(2);
    expect(mockQuickAddJob.mock.calls.filter((c) => c[1] === "normalize")).toHaveLength(0);
  });

  it("rejects an unknown voice", async () => {
    const input = createBookInputSchema.parse({ title: "X", voice: "not-a-voice", chapters: [] });
    await expect(createApiBook(input, DEFAULT_PROFILE_ID)).rejects.toThrow();
  });
});

describe("appendApiChapters", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockClear();
  });

  it("appends after the highest existing index", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
    await db.insert(chapters).values({ bookId, index: 3, title: "Existing", rawText: "x" });

    const input = appendChaptersInputSchema.parse({ chapters: [{ title: "New", text: "n" }] });
    const result = await appendApiChapters(bookId, input);

    expect(result?.chapters).toEqual([expect.objectContaining({ index: 4, title: "New" })]);
    const rows = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(rows.at(-1)?.source).toEqual({ kind: "api" });
  });

  it("returns null for a missing book", async () => {
    const input = appendChaptersInputSchema.parse({ chapters: [{ title: "New", text: "n" }] });
    expect(await appendApiChapters(crypto.randomUUID(), input)).toBeNull();
  });
});

describe("apiBookStatus", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("reports chapter audio state", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Book", kind: "api" });
    await db.insert(chapters).values([
      { bookId, index: 0, title: "A", rawText: "a", status: "done", audioPath: "/a.mp3", durationMs: 5000 },
      { bookId, index: 1, title: "B", rawText: "b", status: "suspended" },
    ]);

    const status = await apiBookStatus(bookId);
    expect(status?.kind).toBe("api");
    expect(status?.chapters).toEqual([
      expect.objectContaining({ index: 0, status: "done", hasAudio: true, durationMs: 5000 }),
      expect.objectContaining({ index: 1, status: "suspended", hasAudio: false }),
    ]);
  });

  it("returns null for a missing book", async () => {
    expect(await apiBookStatus(crypto.randomUUID())).toBeNull();
  });
});
