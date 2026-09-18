import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, chapters, chapterVariants, bookChunks } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});
vi.mock("../lib/search-index.ts", () => ({ queueIndexBook: vi.fn() }));
vi.mock("../lib/log.ts", () => ({ appendLog: vi.fn() }));
import { indexBook } from "./index-book.ts";
import { normalize } from "./normalize.ts";
import { queueIndexBook } from "../lib/search-index.ts";

const addJob = vi.fn();
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);

async function fixture() {
  const db = getDb();
  const book = row(await db.insert(books).values({ title: "Index regression", kind: "api" }).returning());
  const chapter = row(await db.insert(chapters).values({ bookId: book.id, index: 0, title: "Chapter", rawText: "A passage about folklore and village traditions.", pageStart: 2, pageEnd: 3 }).returning());
  return { db, bookId: book.id, chapterId: chapter.id };
}

beforeEach(async () => { await resetDb(getDb()); vi.clearAllMocks(); });

describe("index freshness and preserved embeddings", () => {
  it("updates page-only changes and legacy hashes without replacing embedded chunks", async () => {
    const { db, bookId, chapterId } = await fixture();
    await indexBook({ bookId }, { addJob });
    const before = row(await db.select().from(bookChunks));
    await db.update(bookChunks).set({ embedding: vector, sourceHash: "legacy hash" }).where(eq(bookChunks.id, before.id));
    await db.update(chapters).set({ pageStart: 7, pageEnd: 9 }).where(eq(chapters.id, chapterId));
    await indexBook({ bookId }, { addJob });
    const after = row(await db.select().from(bookChunks));
    expect(after.id).toBe(before.id);
    expect(after.embedding).toEqual(vector);
    expect([after.pageStart, after.pageEnd]).toEqual([7, 9]);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    await indexBook({ bookId }, { addJob });
    expect(row(await db.select().from(bookChunks))).toEqual(after);
  });

  it("refreshes a changed block page map with identical text", async () => {
    const { db, bookId, chapterId } = await fixture();
    const chapter = row(await db.select().from(chapters));
    const block = { text: chapter.rawText, page: 2, included: true, type: "Text" };
    await db.update(chapters).set({ sourceBlocks: [block] }).where(eq(chapters.id, chapterId));
    await indexBook({ bookId }, { addJob });
    const before = row(await db.select().from(bookChunks));
    await db.update(bookChunks).set({ embedding: vector });
    await db.update(chapters).set({ sourceBlocks: [{ ...block, page: 8 }] }).where(eq(chapters.id, chapterId));
    await indexBook({ bookId }, { addJob });
    const after = row(await db.select().from(bookChunks));
    expect(after.id).toBe(before.id);
    expect(after.embedding).toEqual(vector);
    expect([after.pageStart, after.pageEnd]).toEqual([8, 8]);
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });

  it("replaces changed text while preserving the chapter's translated embeddings", async () => {
    const { db, bookId, chapterId } = await fixture();
    await db.insert(chapterVariants).values({ chapterId, key: "bg", text: "Български превод на разказа.", status: "done" });
    await indexBook({ bookId }, { addJob });
    await db.update(bookChunks).set({ embedding: vector });
    const translated = row(await db.select().from(bookChunks).where(eq(bookChunks.source, "translation")));
    await db.update(chapters).set({ customText: "An entirely new passage." }).where(eq(chapters.id, chapterId));
    await indexBook({ bookId }, { addJob });
    expect(row(await db.select().from(bookChunks).where(eq(bookChunks.source, "translation")))).toEqual(translated);
    const changed = row(await db.select().from(bookChunks).where(eq(bookChunks.source, "chapter")));
    expect(changed.text).toBe("An entirely new passage.");
    expect(changed.embedding).toBeNull();
  });

  it("queues a refresh after normalization changes the indexed text", async () => {
    const { db, bookId, chapterId } = await fixture();
    await db.update(chapters).set({ rawText: "Text with **bold** formatting." }).where(eq(chapters.id, chapterId));
    await indexBook({ bookId }, { addJob });
    const before = row(await db.select().from(bookChunks));
    await normalize({ bookId, chapterId }, { addJob });
    const chapter = row(await db.select().from(chapters));
    expect(chapter.cleanText).not.toBe(before.text);
    expect(queueIndexBook).toHaveBeenCalledWith(bookId);
    await indexBook({ bookId }, { addJob });
    expect(row(await db.select().from(bookChunks)).text).toBe(chapter.cleanText);
  });
});
