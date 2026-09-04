import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row as firstRow } from "../../test/setup.ts";
import { books, chapters, type ChapterCleanup } from "../schema.ts";
import { eq } from "drizzle-orm";

vi.mock("../lib/cleanup.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cleanup.ts")>();
  return { ...actual, cleanupChunk: vi.fn() };
});

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../lib/llm.ts", () => ({
  modelChoice: vi.fn(async () => ({ key: "flash", label: "V4 Flash" })),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { cleanup } from "./cleanup.ts";
import { cleanupChunk } from "../lib/cleanup.ts";
import { splitIntoChunks } from "../lib/transform.ts";

const mockCleanupChunk = vi.mocked(cleanupChunk);

const PARA = "One sentence here. ".repeat(60).trim();
const SOURCE = [PARA, PARA, PARA].join("\n\n");

async function insertFixture(
  db: ReturnType<typeof getDb>,
  opts?: { cleanup?: ChapterCleanup; customText?: string },
) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
  const chapterId = crypto.randomUUID();
  await db.insert(chapters).values({
    id: chapterId,
    bookId,
    index: 0,
    title: "Ch",
    rawText: SOURCE,
    customText: opts?.customText,
    cleanup: opts?.cleanup,
  });
  return { bookId, chapterId };
}

describe("cleanup worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockCleanupChunk.mockReset();
  });

  it("cleans all chunks and writes customText once with status done", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    mockCleanupChunk.mockImplementation(async ({ text }) => `CLEAN(${text.slice(0, 10)})`);

    await cleanup({ chapterId, bookId });

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.status).toBe("done");
    expect(row.cleanup?.progress).toBe(`${total}/${total}`);
    expect(row.customText?.split("\n\n")).toHaveLength(total);
    expect(row.rawText).toBe(SOURCE);
    expect(mockCleanupChunk).toHaveBeenCalledTimes(total);
  });

  // The first chunk can take minutes, and a status cell with no numbers in it reads as stuck
  it("records the model and a zero progress before the first chunk returns", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    const seen: (string | undefined)[] = [];
    mockCleanupChunk.mockImplementation(async () => {
      const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
      seen.push(row.cleanup?.progress);
      return "CLEAN";
    });

    await cleanup({ chapterId, bookId });

    expect(seen[0]).toBe(`0/${total}`);
    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.model).toBe("V4 Flash");
  });

  it("cleans from customText when present", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db, { customText: "Edited once." });
    mockCleanupChunk.mockResolvedValue("Edited once, cleaned.");

    await cleanup({ chapterId, bookId });

    expect(mockCleanupChunk).toHaveBeenCalledWith({ text: "Edited once." });
    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.customText).toBe("Edited once, cleaned.");
  });

  it("drops chunks that clean to empty", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    expect(total).toBeGreaterThan(1);
    let calls = 0;
    mockCleanupChunk.mockImplementation(async () => (++calls === 1 ? "" : `CLEAN-${calls}`));

    await cleanup({ chapterId, bookId });

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.status).toBe("done");
    expect(row.customText?.split("\n\n")).toHaveLength(total - 1);
  });

  it("fails without touching the text when everything cleans to empty", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    mockCleanupChunk.mockResolvedValue("");

    await expect(cleanup({ chapterId, bookId })).rejects.toThrow("removed all text");

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.status).toBe("failed");
    expect(row.cleanup?.error).toContain("removed all text");
    expect(row.customText).toBeNull();
  });

  it("does nothing when suspended before start", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const { bookId, chapterId } = await insertFixture(db, {
      cleanup: { status: "suspended", createdAt: now, updatedAt: now },
    });

    await cleanup({ chapterId, bookId });

    expect(mockCleanupChunk).not.toHaveBeenCalled();
    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.status).toBe("suspended");
  });

  it("stops mid-run without writing text when suspended", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    expect(total).toBeGreaterThan(1);

    let calls = 0;
    mockCleanupChunk.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const current = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
        await db
          .update(chapters)
          .set({ cleanup: { ...current.cleanup!, status: "suspended" } })
          .where(eq(chapters.id, chapterId));
      }
      return `CLEAN-${calls}`;
    });

    await cleanup({ chapterId, bookId });

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.status).toBe("suspended");
    expect(row.customText).toBeNull();
    expect(mockCleanupChunk).toHaveBeenCalledTimes(1);
  });

  it("stops writing when a newer run takes over the chapter", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    expect(total).toBeGreaterThan(1);

    let calls = 0;
    mockCleanupChunk.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        const current = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
        await db
          .update(chapters)
          .set({ cleanup: { ...current.cleanup!, runToken: "newer-run" } })
          .where(eq(chapters.id, chapterId));
      }
      return `CLEAN-${calls}`;
    });

    await cleanup({ chapterId, bookId });

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.runToken).toBe("newer-run");
    expect(row.customText).toBeNull();
    expect(mockCleanupChunk).toHaveBeenCalledTimes(1);
  });

  it("marks the chapter failed when the provider throws", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    mockCleanupChunk.mockRejectedValue(new Error("API down"));

    await expect(cleanup({ chapterId, bookId })).rejects.toThrow("API down");

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.status).toBe("failed");
    expect(row.cleanup?.error).toBe("API down");
    expect(row.customText).toBeNull();
  });
});
