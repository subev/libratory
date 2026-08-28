import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, bookFiles, notes } from "../schema.ts";
import { eq } from "drizzle-orm";

const { mockDeepseekChat, mockEnv } = vi.hoisted(() => ({
  mockDeepseekChat: vi.fn(async (..._args: unknown[]) => "AI answer"),
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

import { bookNote } from "./book-note.ts";

async function insertBookWithRawText(rawText: string | null) {
  const db = getDb();
  const bookId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(books).values({
    id: bookId,
    title: "Book",
    filename: "b.pdf",
    pdfPath: "/tmp/b.pdf",
    noteJob: { status: "queued", prompt: "Summarize", model: "flash", createdAt: now, updatedAt: now },
  });
  await db.insert(bookFiles).values({
    bookId,
    index: 0,
    filename: "b.pdf",
    pdfPath: "/tmp/b.pdf",
    status: "raw",
    rawText,
    rawWords: rawText ? rawText.split(/\s+/).length : null,
  });
  return bookId;
}

describe("bookNote worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockDeepseekChat.mockReset();
    mockDeepseekChat.mockResolvedValue("AI answer");
    mockEnv.DEEPSEEK_API_KEY = "test-key";
  });

  it("saves a note with the custom prompt and marks the job done", async () => {
    const bookId = await insertBookWithRawText("Some raw book text.");

    await bookNote({ bookId, prompt: "List the villains", model: "pro" });

    const db = getDb();
    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.noteJob?.status).toBe("done");
    expect(book.noteJob?.noteId).toBeTruthy();

    const note = row(await db.select().from(notes).where(eq(notes.bookId, bookId)));
    expect(note).toMatchObject({
      prompt: "List the villains",
      model: "pro",
      result: "AI answer",
      scope: { kind: "book-raw", files: 1 },
    });
    const userMessage = mockDeepseekChat.mock.calls[0]?.[1] as string;
    expect(userMessage).toContain("List the villains");
    expect(userMessage).toContain("Some raw book text.");
  });

  it("fails the job when the API key is missing", async () => {
    const bookId = await insertBookWithRawText("text");
    mockEnv.DEEPSEEK_API_KEY = undefined;

    await expect(bookNote({ bookId, prompt: "Summarize", model: "flash" })).rejects.toThrow(/DEEPSEEK_API_KEY/);

    const db = getDb();
    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.noteJob?.status).toBe("failed");
    expect(mockDeepseekChat).not.toHaveBeenCalled();
  });

  it("fails the job when no raw text exists", async () => {
    const bookId = await insertBookWithRawText(null);

    await expect(bookNote({ bookId, prompt: "Summarize", model: "flash" })).rejects.toThrow(/no raw text/i);

    const db = getDb();
    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.noteJob?.status).toBe("failed");
  });

  it("records the DeepSeek error on the job and rethrows", async () => {
    const bookId = await insertBookWithRawText("text");
    mockDeepseekChat.mockRejectedValue(new Error("DeepSeek API error 500"));

    await expect(bookNote({ bookId, prompt: "Summarize", model: "flash" })).rejects.toThrow(/500/);

    const db = getDb();
    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.noteJob?.status).toBe("failed");
    expect(book.noteJob?.error).toContain("500");
    expect(await db.select().from(notes)).toHaveLength(0);
  });
});
