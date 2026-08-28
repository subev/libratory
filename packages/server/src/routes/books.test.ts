import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureGraphileTables, getDb, insertJob, resetDb } from "../../test/setup.ts";
import { books, bookFiles, chapters, folders, profiles } from "../schema.ts";

const { mockQuickAddJob, mockDeepseekChat } = vi.hoisted(() => ({
  mockQuickAddJob: vi.fn(async () => {}),
  mockDeepseekChat: vi.fn(async (..._args: unknown[]) => "AI answer"),
}));

vi.mock("graphile-worker", () => ({
  quickAddJob: mockQuickAddJob,
}));

vi.mock("../lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/llm.ts")>();
  return { ...actual, llmChat: mockDeepseekChat };
});

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("../lib/marker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/marker.ts")>();
  return { ...actual, collectBlocksFromMarkerOutput: vi.fn() };
});

import { booksRouter } from "./books.ts";
import { collectBlocksFromMarkerOutput, type FlatBlock } from "../lib/marker.ts";

const mockCollectBlocks = vi.mocked(collectBlocksFromMarkerOutput);

describe("booksRouter.updateSettings", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("rejects unsupported voice ids", async () => {
    const db = getDb();
    const id = crypto.randomUUID();

    await db.insert(books).values({
      id,
      title: "Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      voice: "kokoro:af_heart",
      speed: 1.0,
    });

    const caller = booksRouter.createCaller({});

    await expect(caller.updateSettings({ id, voice: "bg-mms:nope" })).rejects.toThrow(/unsupported voice/i);
  });

  it("re-queues selected done chapters for synthesis with cleared audio metadata", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      voice: "bg-mms:bul",
      speed: 1.0,
    });

    await db.insert(chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Chapter 1",
      rawText: "Добро утро.",
      cleanText: "Добро утро.",
      status: "done",
      selected: true,
      audioPath: "/tmp/ch000.mp3",
      durationMs: 12345,
      progress: "2/2",
      synthesizedWith: { voice: "bg-mlx:narrator", speed: null },
    });

    const caller = booksRouter.createCaller({});

    await caller.processSelected({ id: bookId });

    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.any(Object),
      "synthesize",
      { chapterId, bookId },
      { maxAttempts: 1 }
    );

    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
    expect(chapter.status).toBe("pending");
    expect(chapter.audioPath).toBeNull();
    expect(chapter.durationMs).toBeNull();
    expect(chapter.progress).toBeNull();
    expect(chapter.synthesizedWith).toBeNull();
    expect(chapter.error).toBeNull();
  });
});

function block(type: string, text: string, page: number): FlatBlock {
  return { type, text, hierarchy: null, page, included: true };
}

const structureBlocks = [
  block("Text", "Front matter words here", 1),
  block("SectionHeader", "Chapter 1 Beginning", 2),
  block("Text", "one two three four five", 3),
  block("SectionHeader", "Chapter 2 Middle", 10),
  block("Text", "six seven eight", 11),
];

async function insertStructureBook(db: ReturnType<typeof getDb>) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({
    id: bookId,
    title: "Book",
    filename: "book.pdf",
    pdfPath: "/tmp/book.pdf",
  });
  await db.insert(chapters).values({
    bookId,
    index: 0,
    title: "Chapter 1 Beginning",
    rawText: "old",
    pageStart: 2,
    status: "suspended",
  });
  return bookId;
}

describe("booksRouter.structure", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockCollectBlocks.mockReset();
  });

  it("returns the heading outline with word offsets and current boundaries", async () => {
    const bookId = await insertStructureBook(getDb());
    mockCollectBlocks.mockResolvedValue(structureBlocks);

    const caller = booksRouter.createCaller({});
    const { files } = await caller.structure({ id: bookId });

    expect(files).toHaveLength(1);
    expect(files[0].fileIndex).toBeNull();
    expect(files[0].totalWords).toBe(18);
    expect(files[0].totalPages).toBe(11);
    expect(files[0].headings).toEqual([
      { blockIndex: 1, page: 2, level: null, text: "Chapter 1 Beginning", wordsBefore: 4, isChapterStart: true },
      { blockIndex: 3, page: 10, level: null, text: "Chapter 2 Middle", wordsBefore: 12, isChapterStart: false },
    ]);
  });

  it("flags files whose extraction output is missing", async () => {
    const bookId = await insertStructureBook(getDb());
    mockCollectBlocks.mockRejectedValue(new Error("no marker output"));

    const caller = booksRouter.createCaller({});
    const { files } = await caller.structure({ id: bookId });

    expect(files[0].missing).toBe(true);
    expect(files[0].headings).toEqual([]);
  });
});

describe("booksRouter.applyChapterBoundaries", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockCollectBlocks.mockReset();
    mockQuickAddJob.mockReset();
  });

  it("replaces chapters by slicing at the chosen block indices", async () => {
    const db = getDb();
    const bookId = await insertStructureBook(db);
    mockCollectBlocks.mockResolvedValue(structureBlocks);

    const caller = booksRouter.createCaller({});
    const updated = await caller.applyChapterBoundaries({
      id: bookId,
      boundaries: [
        { fileIndex: null, blockIndex: 1 },
        { fileIndex: null, blockIndex: 3 },
      ],
    });

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(chapters.index);
    expect(chs.map((c) => c.title)).toEqual(["Chapter 1 Beginning", "Chapter 2 Middle"]);
    expect(chs.every((c) => c.status === "suspended")).toBe(true);
    expect(chs.map((c) => [c.pageStart, c.pageEnd])).toEqual([[2, 3], [10, 11]]);

    expect(updated.chapterDetection).toBe("manual");
    expect(updated.totalChapters).toBe(2);
    expect(updated.chapterProposal).toBeNull();
    expect(updated.status).toBe("pending");
  });

  it("applies proposal title overrides to the sliced chapters", async () => {
    const db = getDb();
    const bookId = await insertStructureBook(db);
    mockCollectBlocks.mockResolvedValue(structureBlocks);

    const caller = booksRouter.createCaller({});
    await caller.applyChapterBoundaries({
      id: bookId,
      boundaries: [
        { fileIndex: null, blockIndex: 1, title: "Chapter 1: The Beginning" },
        { fileIndex: null, blockIndex: 3 },
      ],
    });

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(chapters.index);
    expect(chs.map((c) => c.title)).toEqual(["Chapter 1: The Beginning", "Chapter 2 Middle"]);
  });

  it("rejects out-of-range block indices without touching existing chapters", async () => {
    const db = getDb();
    const bookId = await insertStructureBook(db);
    mockCollectBlocks.mockResolvedValue(structureBlocks);

    const caller = booksRouter.createCaller({});
    await expect(
      caller.applyChapterBoundaries({ id: bookId, boundaries: [{ fileIndex: null, blockIndex: 99 }] })
    ).rejects.toThrow(/out of range/);

    const chs = await db.select().from(chapters).where(eq(chapters.bookId, bookId));
    expect(chs).toHaveLength(1);
    expect(chs[0].title).toBe("Chapter 1 Beginning");
  });
});

describe("booksRouter.proposeChapters", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  it("stores a running proposal and enqueues the propose job", async () => {
    const bookId = await insertStructureBook(getDb());

    const caller = booksRouter.createCaller({});
    const updated = await caller.proposeChapters({ id: bookId, method: "deterministic" });

    expect(updated.chapterProposal?.status).toBe("running");
    expect(updated.chapterProposal?.method).toBe("deterministic");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.any(Object),
      "propose",
      { bookId, method: "deterministic" },
      { maxAttempts: 1 }
    );
  });

  it("rejects while a fresh proposal is still running", async () => {
    const db = getDb();
    const bookId = await insertStructureBook(db);
    await db
      .update(books)
      .set({ chapterProposal: { status: "running", method: "llm", createdAt: new Date().toISOString() } })
      .where(eq(books.id, bookId));

    const caller = booksRouter.createCaller({});
    await expect(caller.proposeChapters({ id: bookId, method: "llm" })).rejects.toThrow(/already running/);
  });
});

describe("booksRouter.extractChapters", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  async function insertRawBook(statuses: ("raw" | "done" | "pending")[]) {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({
      id: bookId,
      title: "Raw Book",
      filename: "raw.pdf",
      pdfPath: "/tmp/raw.pdf",
    });
    await db.insert(bookFiles).values(
      statuses.map((status, i) => ({
        bookId,
        index: i,
        filename: `f${i}.pdf`,
        pdfPath: `/tmp/f${i}.pdf`,
        status,
      })),
    );
    return bookId;
  }

  it("flips raw files to pending and queues extract", async () => {
    const bookId = await insertRawBook(["raw", "raw"]);

    const caller = booksRouter.createCaller({});
    await caller.extractChapters({ id: bookId });

    const db = getDb();
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId));
    expect(files.every((f) => f.status === "pending")).toBe(true);
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.any(Object),
      "extract",
      { bookId },
      { maxAttempts: 1 }
    );
  });

  it("rejects when every file is already extracted", async () => {
    const bookId = await insertRawBook(["done"]);

    const caller = booksRouter.createCaller({});
    await expect(caller.extractChapters({ id: bookId })).rejects.toThrow(/already extracted/i);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("rejects while the book is extracting", async () => {
    const bookId = await insertRawBook(["raw"]);
    const db = getDb();
    await db.update(books).set({ status: "extracting" }).where(eq(books.id, bookId));

    const caller = booksRouter.createCaller({});
    await expect(caller.extractChapters({ id: bookId })).rejects.toThrow(/while book is processing/i);
  });
});

describe("booksRouter.get raw text stats", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("ships rawWords and hasRawText but never rawText", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({
      id: bookId,
      title: "Raw Book",
      filename: "raw.pdf",
      pdfPath: "/tmp/raw.pdf",
    });
    await db.insert(bookFiles).values([
      { bookId, index: 0, filename: "a.pdf", pdfPath: "/tmp/a.pdf", status: "raw", rawText: "one two three", rawWords: 3 },
      { bookId, index: 1, filename: "b.pdf", pdfPath: "/tmp/b.pdf", status: "raw" },
    ]);

    const caller = booksRouter.createCaller({});
    const book = await caller.get({ id: bookId });

    expect(book.rawTextTotalWords).toBe(3);
    expect(book.files[0]).toMatchObject({ rawWords: 3, hasRawText: true });
    expect(book.files[1]).toMatchObject({ rawWords: null, hasRawText: false });
    expect((book.files[0] as Record<string, unknown>).rawText).toBeUndefined();
  });
});

describe("booksRouter.get derived status", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("reports done, not assembling, when all chapters are done but no assembly exists", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({
      id: bookId,
      title: "Digest",
      kind: "digest",
      status: "done",
      outputPath: null,
    });
    await db.insert(chapters).values([
      { bookId, index: 0, title: "Ch 1", rawText: "text", status: "done" },
      { bookId, index: 1, title: "Ch 2", rawText: "text", status: "done" },
    ]);

    const caller = booksRouter.createCaller({});
    const book = await caller.get({ id: bookId });

    expect(book.status).toBe("done");
  });

  it("reports assembleQueued while an assemble job is in the queue", async () => {
    const db = getDb();
    await ensureGraphileTables(db);
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Book", status: "done" });

    const caller = booksRouter.createCaller({});
    expect((await caller.get({ id: bookId })).assembleQueued).toBe(false);

    await insertJob(db, "assemble", { bookId });
    expect((await caller.get({ id: bookId })).assembleQueued).toBe(true);
  });
});

describe("booksRouter.rawTextStats", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("counts ascii/nonAscii across files and reports missing ones", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "B", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
    await db.insert(bookFiles).values([
      { bookId, index: 0, filename: "a.pdf", pdfPath: "/tmp/a.pdf", status: "raw", rawText: "abcd" },
      { bookId, index: 1, filename: "b.pdf", pdfPath: "/tmp/b.pdf", status: "raw", rawText: "абв" },
      { bookId, index: 2, filename: "c.pdf", pdfPath: "/tmp/c.pdf", status: "raw" },
    ]);

    const caller = booksRouter.createCaller({});
    const stats = await caller.rawTextStats({ bookId });

    expect(stats).toEqual({ ascii: 4, nonAscii: 3, fileCount: 2, missingFiles: 1 });
  });
});

describe("booksRouter.deleteMany", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("deletes all given books and their dependent rows", async () => {
    const db = getDb();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      await db.insert(books).values({ id, title: `Book ${id.slice(0, 4)}`, filename: "b.pdf", pdfPath: `/tmp/del-${id}/b.pdf` });
      await db.insert(chapters).values({ bookId: id, index: 0, title: "Ch", rawText: "text" });
    }
    const keptId = crypto.randomUUID();
    await db.insert(books).values({ id: keptId, title: "Kept", filename: "k.pdf", pdfPath: "/tmp/k.pdf" });

    const caller = booksRouter.createCaller({});
    const res = await caller.deleteMany({ ids });

    expect(res.deleted).toBe(2);
    const remaining = await db.select().from(books);
    expect(remaining.map((b) => b.id)).toEqual([keptId]);
    expect(await db.select().from(chapters)).toHaveLength(0);
  });
});

describe("synthetic book guards", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  async function insertDigestBook() {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Digest", kind: "digest" });
    await db.insert(chapters).values({ bookId, index: 0, title: "Summary", rawText: "generated text", status: "suspended" });
    return bookId;
  }

  it("retry refuses and keeps chapters", async () => {
    const bookId = await insertDigestBook();
    const caller = booksRouter.createCaller({});

    await expect(caller.retry({ id: bookId })).rejects.toThrow(/synthetic/i);

    const db = getDb();
    expect(await db.select().from(chapters).where(eq(chapters.bookId, bookId))).toHaveLength(1);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("redetectChapters refuses without flipping status", async () => {
    const bookId = await insertDigestBook();
    const caller = booksRouter.createCaller({});

    await expect(caller.redetectChapters({ id: bookId })).rejects.toThrow(/synthetic/i);

    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    expect(book.status).toBe("pending");
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("extractChapters, proposeChapters, and applyChapterBoundaries refuse cleanly", async () => {
    const bookId = await insertDigestBook();
    const caller = booksRouter.createCaller({});

    await expect(caller.extractChapters({ id: bookId })).rejects.toThrow(/synthetic/i);
    await expect(caller.proposeChapters({ id: bookId, method: "llm" })).rejects.toThrow(/synthetic/i);
    await expect(
      caller.applyChapterBoundaries({ id: bookId, boundaries: [{ fileIndex: null, blockIndex: 0 }] })
    ).rejects.toThrow(/synthetic/i);

    const db = getDb();
    expect(await db.select().from(chapters).where(eq(chapters.bookId, bookId))).toHaveLength(1);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("structure returns no files for a synthetic book", async () => {
    const bookId = await insertDigestBook();
    const caller = booksRouter.createCaller({});

    const { files } = await caller.structure({ id: bookId });
    expect(files).toEqual([]);
  });
});

describe("booksRouter.createDigest", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  async function insertSourceWithRawText(title: string, rawText: string | null) {
    const db = getDb();
    const id = crypto.randomUUID();
    await db.insert(books).values({ id, title, filename: "s.pdf", pdfPath: "/tmp/s.pdf" });
    await db.insert(bookFiles).values({ id: crypto.randomUUID(), bookId: id, index: 0, filename: "s.pdf", pdfPath: "/tmp/s.pdf", status: "raw", rawText });
    return id;
  }

  it("creates a digest book with origin and queues the digest job", async () => {
    const a = await insertSourceWithRawText("A", "text a");
    const b = await insertSourceWithRawText("B", "text b");

    const caller = booksRouter.createCaller({});
    const digestBook = await caller.createDigest({
      title: "Weekly digest",
      sourceBookIds: [a, b],
      prompt: "Narrate",
      model: "flash",
    });

    expect(digestBook.kind).toBe("digest");
    expect(digestBook.pdfPath).toBeNull();
    expect(digestBook.skipSynthesis).toBe(true);
    expect(digestBook.origin).toEqual({ type: "digest", sourceBookIds: [a, b], prompt: "Narrate", model: "flash" });
    expect(digestBook.digestJob?.status).toBe("running");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.any(Object),
      "digest",
      { bookId: digestBook.id },
      { maxAttempts: 1 }
    );
  });

  it("places the digest in the given folder", async () => {
    const db = getDb();
    const [folder] = await db.insert(folders).values({ name: "Digests" }).returning();
    const a = await insertSourceWithRawText("A", "text a");
    const b = await insertSourceWithRawText("B", "text b");

    const caller = booksRouter.createCaller({});
    const digestBook = await caller.createDigest({
      title: "Weekly digest",
      sourceBookIds: [a, b],
      prompt: "Narrate",
      folderId: folder.id,
    });

    expect(digestBook.folderId).toBe(folder.id);
  });

  it("rejects when a source has no text", async () => {
    const a = await insertSourceWithRawText("Good", "text");
    const b = await insertSourceWithRawText("Scanned book", null);

    const caller = booksRouter.createCaller({});
    await expect(
      caller.createDigest({ title: "D", sourceBookIds: [a, b], prompt: "Narrate", model: "flash" })
    ).rejects.toThrow(/Scanned book/);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("resumeDigest re-queues a failed digest and rejects fresh-running ones", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const [digestBook] = await db
      .insert(books)
      .values({
        title: "D",
        kind: "digest",
        origin: { type: "digest", sourceBookIds: [crypto.randomUUID(), crypto.randomUUID()], prompt: "p", model: "flash" },
        digestJob: { status: "failed", error: "boom", createdAt: now, updatedAt: now },
      })
      .returning();

    const caller = booksRouter.createCaller({});
    const resumed = await caller.resumeDigest({ id: digestBook.id });
    expect(resumed.digestJob?.status).toBe("running");
    expect(mockQuickAddJob).toHaveBeenCalledTimes(1);

    await expect(caller.resumeDigest({ id: digestBook.id })).rejects.toThrow(/already running/);
  });
});

describe("booksRouter.search", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("matches all words case-insensitively and returns the folder path", async () => {
    const db = getDb();
    const [root] = await db.insert(folders).values({ name: "History" }).returning();
    const [sub] = await db.insert(folders).values({ name: "Ancient", parentId: root.id }).returning();
    await db.insert(books).values([
      { title: "The Empire of the City", folderId: sub.id },
      { title: "Empire Falls" },
      { title: "Unrelated" },
    ]);

    const caller = booksRouter.createCaller({});
    const results = await caller.search({ query: "empire CITY" });
    expect(results.map((b) => b.title)).toEqual(["The Empire of the City"]);
    expect(results[0].folderPath.map((f) => f.name)).toEqual(["History", "Ancient"]);

    const both = await caller.search({ query: "empire" });
    expect(both.map((b) => b.title).sort()).toEqual(["Empire Falls", "The Empire of the City"]);
  });

  it("treats like wildcards as literals", async () => {
    const db = getDb();
    await db.insert(books).values([{ title: "100% Cotton" }, { title: "100 Cotton" }]);

    const caller = booksRouter.createCaller({});
    const results = await caller.search({ query: "100%" });
    expect(results.map((b) => b.title)).toEqual(["100% Cotton"]);
  });

  it("is scoped to the caller's profile", async () => {
    const db = getDb();
    const [other] = await db.insert(profiles).values({ name: "Wife" }).returning();
    await db.insert(books).values([
      { title: "Shared title" },
      { title: "Shared title", profileId: other.id },
    ]);

    const results = await booksRouter.createCaller({ profileId: other.id }).search({ query: "shared" });
    expect(results).toHaveLength(1);
    expect(results[0].folderPath).toEqual([]);
  });
});

describe("booksRouter.textAvailability", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("flags books with chapters or raw text as usable, bare books as not", async () => {
    const db = getDb();
    const chaptered = crypto.randomUUID();
    const rawOnly = crypto.randomUUID();
    const bare = crypto.randomUUID();
    await db.insert(books).values([
      { id: chaptered, title: "Chaptered" },
      { id: rawOnly, title: "Raw only" },
      { id: bare, title: "Bare" },
    ]);
    await db.insert(chapters).values({ bookId: chaptered, index: 0, title: "Ch 1", rawText: "text" });
    await db.insert(bookFiles).values([
      { bookId: rawOnly, index: 0, filename: "r.pdf", pdfPath: "/tmp/r.pdf", status: "raw", rawText: "raw text" },
      { bookId: bare, index: 0, filename: "b.pdf", pdfPath: "/tmp/b.pdf", status: "pending" },
    ]);

    const caller = booksRouter.createCaller({});
    const results = await caller.textAvailability({ ids: [chaptered, rawOnly, bare] });
    expect(results).toEqual([
      { id: chaptered, hasText: true },
      { id: rawOnly, hasText: true },
      { id: bare, hasText: false },
    ]);
  });
});

describe("booksRouter.list hasText", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("flags books without chapters or raw text", async () => {
    const db = getDb();
    const chaptered = crypto.randomUUID();
    const rawOnly = crypto.randomUUID();
    const bare = crypto.randomUUID();
    await db.insert(books).values([
      { id: chaptered, title: "Chaptered" },
      { id: rawOnly, title: "Raw only" },
      { id: bare, title: "Bare" },
    ]);
    await db.insert(chapters).values({ bookId: chaptered, index: 0, title: "Ch 1", rawText: "text" });
    await db.insert(bookFiles).values([
      { bookId: rawOnly, index: 0, filename: "r.pdf", pdfPath: "/tmp/r.pdf", status: "raw", rawText: "raw text" },
      { bookId: bare, index: 0, filename: "b.pdf", pdfPath: "/tmp/b.pdf", status: "raw" },
    ]);

    const caller = booksRouter.createCaller({});
    const { books: overview } = await caller.list({ folderId: null });
    const byTitle = new Map(overview.map((b) => [b.title, b.hasText]));
    expect(byTitle.get("Chaptered")).toBe(true);
    expect(byTitle.get("Raw only")).toBe(true);
    expect(byTitle.get("Bare")).toBe(false);
  });
});
