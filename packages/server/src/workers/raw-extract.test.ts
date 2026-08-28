import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, bookFiles } from "../schema.ts";
import { eq, asc } from "drizzle-orm";

vi.mock("../lib/pdf-raw-text.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/pdf-raw-text.ts")>();
  return { ...actual, extractPdfRawText: vi.fn() };
});

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { rawExtract } from "./raw-extract.ts";
import { extractPdfRawText } from "../lib/pdf-raw-text.ts";

const mockExtract = vi.mocked(extractPdfRawText);

async function insertBook(db: ReturnType<typeof getDb>, fileCount: number) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({
    id: bookId,
    title: "Raw Book",
    filename: "raw.pdf",
    pdfPath: "/tmp/raw_0.pdf",
  });
  await db.insert(bookFiles).values(
    Array.from({ length: fileCount }, (_, i) => ({
      bookId,
      index: i,
      filename: `raw_${i}.pdf`,
      pdfPath: `/tmp/raw_${i}.pdf`,
      status: "raw" as const,
    })),
  );
  return bookId;
}

describe("rawExtract worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockExtract.mockReset();
  });

  it("stores raw text and word count per file", async () => {
    const db = getDb();
    const bookId = await insertBook(db, 2);
    mockExtract.mockResolvedValueOnce("one two three").mockResolvedValueOnce("четири пет");

    await rawExtract({ bookId }, { addJob: vi.fn() } as any);

    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)).orderBy(asc(bookFiles.index));
    expect(files[0]?.rawText).toBe("one two three");
    expect(files[0]?.rawWords).toBe(3);
    expect(files[1]?.rawText).toBe("четири пет");
    expect(files[1]?.rawWords).toBe(2);
  });

  it("skips files that already have raw text", async () => {
    const db = getDb();
    const bookId = await insertBook(db, 2);
    await db.update(bookFiles).set({ rawText: "existing", rawWords: 1 }).where(eq(bookFiles.index, 0));
    mockExtract.mockResolvedValue("fresh text here");

    await rawExtract({ bookId }, { addJob: vi.fn() } as any);

    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockExtract).toHaveBeenCalledWith("/tmp/raw_1.pdf");
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)).orderBy(asc(bookFiles.index));
    expect(files[0]?.rawText).toBe("existing");
  });

  it("leaves rawText null when extraction yields nothing", async () => {
    const db = getDb();
    const bookId = await insertBook(db, 1);
    mockExtract.mockResolvedValue(null);

    await rawExtract({ bookId }, { addJob: vi.fn() } as any);

    const file = row(await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)));
    expect(file.rawText).toBeNull();
    expect(file.rawWords).toBeNull();
  });

  it("chains a bookNote job when a note is requested and text was extracted", async () => {
    const db = getDb();
    const bookId = await insertBook(db, 1);
    mockExtract.mockResolvedValue("some text");
    const addJob = vi.fn();

    await rawExtract({ bookId, note: { prompt: "Summarize this book", model: "flash" } }, { addJob } as any);

    expect(addJob).toHaveBeenCalledWith(
      "bookNote",
      { bookId, prompt: "Summarize this book", model: "flash" },
      { maxAttempts: 1 },
    );
  });

  it("fails the noteJob instead of chaining when no file yields text", async () => {
    const db = getDb();
    const bookId = await insertBook(db, 1);
    const now = new Date().toISOString();
    await db
      .update(books)
      .set({ noteJob: { status: "queued", prompt: "Summarize", model: "flash", createdAt: now, updatedAt: now } })
      .where(eq(books.id, bookId));
    mockExtract.mockResolvedValue(null);
    const addJob = vi.fn();

    await rawExtract({ bookId, note: { prompt: "Summarize", model: "flash" } }, { addJob } as any);

    expect(addJob).not.toHaveBeenCalled();
    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.noteJob?.status).toBe("failed");
    expect(book.noteJob?.error).toMatch(/no raw text/i);
  });
});
