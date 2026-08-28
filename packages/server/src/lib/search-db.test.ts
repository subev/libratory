import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, bookFiles, bookChunks, folders, DEFAULT_PROFILE_ID } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

const { searchLibrary } = await import("./search.ts");

async function insertBookWithChunk(text: string, folderId: string | null = null) {
  const db = getDb();
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: `Book ${text.slice(0, 12)}`, filename: "b.pdf", pdfPath: "/tmp/b.pdf", folderId });
  const fileId = crypto.randomUUID();
  await db.insert(bookFiles).values({ id: fileId, bookId, index: 0, filename: "b.pdf", pdfPath: "/tmp/b.pdf", status: "raw", rawText: text });
  await db.insert(bookChunks).values({
    bookId,
    profileId: DEFAULT_PROFILE_ID,
    folderId,
    source: "raw",
    bookFileId: fileId,
    seq: 0,
    text,
    charStart: 0,
    charEnd: text.length,
    pageStart: 1,
    pageEnd: 1,
    sourceHash: "hash",
  });
  return bookId;
}

describe("searchLibrary (keyword mode, real Postgres)", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("finds chunks by words across the whole profile", async () => {
    await insertBookWithChunk("Bitwise tricks count subsets in binary representation.");
    const result = await searchLibrary({ profileId: DEFAULT_PROFILE_ID, query: "binary subsets", mode: "keyword" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.text).toContain("binary");
  });

  it("folder scope restricts to the folder subtree (regression: array param SQL shape)", async () => {
    const db = getDb();
    const folderId = crypto.randomUUID();
    await db.insert(folders).values({ id: folderId, name: "cs" });
    await insertBookWithChunk("Binary heaps and binary search inside the folder.", folderId);
    await insertBookWithChunk("Binary stars outside any folder.");

    const scoped = await searchLibrary({ profileId: DEFAULT_PROFILE_ID, folderId, query: "binary", mode: "keyword" });
    expect(scoped.hits).toHaveLength(1);
    expect(scoped.hits[0]?.text).toContain("inside the folder");
  });

  it("book scope restricts to one book", async () => {
    const target = await insertBookWithChunk("Binary trees explained for interviews.");
    await insertBookWithChunk("Binary options trading history.");

    const result = await searchLibrary({ profileId: DEFAULT_PROFILE_ID, bookId: target, query: "binary", mode: "keyword" });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.bookId).toBe(target);
  });
});
