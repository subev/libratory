import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, ensureGraphileTables, row } from "../../test/setup.ts";
import { books, chapters, type ChapterCleanup } from "../schema.ts";
import { eq } from "drizzle-orm";

const { mockQuickAddJob, mockDeepseekChat } = vi.hoisted(() => ({
  mockQuickAddJob: vi.fn(async () => {}),
  mockDeepseekChat: vi.fn(async (..._args: unknown[]) => "AI answer"),
}));
vi.mock("graphile-worker", () => ({ quickAddJob: mockQuickAddJob }));

vi.mock("../lib/llm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/llm.ts")>();
  return { ...actual, llmChat: mockDeepseekChat };
});

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { chaptersRouter } from "./chapters.ts";

const caller = chaptersRouter.createCaller({});

function cleanupState(status: ChapterCleanup["status"], opts?: { updatedAt?: string }): ChapterCleanup {
  const now = new Date().toISOString();
  return { status, createdAt: now, updatedAt: opts?.updatedAt ?? now };
}

async function insertFixture(
  db: ReturnType<typeof getDb>,
  opts?: { cleanup?: ChapterCleanup; selected?: boolean; bookId?: string; index?: number },
) {
  const bookId = opts?.bookId ?? crypto.randomUUID();
  if (!opts?.bookId) {
    await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
  }
  const chapterId = crypto.randomUUID();
  await db.insert(chapters).values({
    id: chapterId,
    bookId,
    index: opts?.index ?? 0,
    title: "Ch",
    rawText: "Some text.",
    cleanup: opts?.cleanup,
    selected: opts?.selected ?? true,
  });
  return { bookId, chapterId };
}

describe("chapters router cleanup", () => {
  beforeAll(async () => {
    await ensureGraphileTables(getDb());
  });

  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockClear();
  });

  it("queueCleanup sets pending state and enqueues a job", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);

    await caller.queueCleanup({ id: chapterId });

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.cleanup?.status).toBe("pending");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "cleanup",
      { chapterId, bookId },
      { maxAttempts: 1 },
    );
  });

  it("queueCleanup re-runs a finished cleanup", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db, { cleanup: cleanupState("done") });

    await caller.queueCleanup({ id: chapterId });

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.cleanup?.status).toBe("pending");
    expect(mockQuickAddJob).toHaveBeenCalledTimes(1);
  });

  it("queueCleanup rejects while a fresh cleanup is running", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db, { cleanup: cleanupState("cleaning") });

    await expect(caller.queueCleanup({ id: chapterId })).rejects.toThrow("already running");
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("queueCleanup takes over a stale running cleanup", async () => {
    const db = getDb();
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    const { chapterId } = await insertFixture(db, { cleanup: cleanupState("cleaning", { updatedAt: stale }) });

    await caller.queueCleanup({ id: chapterId });

    expect(mockQuickAddJob).toHaveBeenCalledTimes(1);
  });

  it("stopCleanup suspends a running cleanup", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db, { cleanup: cleanupState("cleaning") });

    await caller.stopCleanup({ id: chapterId });

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.cleanup?.status).toBe("suspended");
  });

  it("stopCleanup rejects when nothing is running", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db, { cleanup: cleanupState("done") });

    await expect(caller.stopCleanup({ id: chapterId })).rejects.toThrow("not running");
  });

  it("cleanupSelected queues selected chapters, skipping done, running, and unselected ones", async () => {
    const db = getDb();
    const { bookId, chapterId: plain } = await insertFixture(db);
    const { chapterId: failed } = await insertFixture(db, { bookId, index: 1, cleanup: cleanupState("failed") });
    await insertFixture(db, { bookId, index: 2, cleanup: cleanupState("done") });
    await insertFixture(db, { bookId, index: 3, cleanup: cleanupState("cleaning") });
    await insertFixture(db, { bookId, index: 4, selected: false });

    const result = await caller.cleanupSelected({ bookId });

    expect(result.queued).toBe(2);
    const queuedIds = mockQuickAddJob.mock.calls.map((c: any[]) => c[2].chapterId);
    expect(queuedIds.sort()).toEqual([plain, failed].sort());
  });

  it("cleanupSelected does not treat a manual custom text as cleaned", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.update(chapters).set({ customText: "manually edited" }).where(eq(chapters.id, chapterId));

    const result = await caller.cleanupSelected({ bookId });

    expect(result.queued).toBe(1);
  });

  it("cleanupSelected rejects when nothing needs cleanup", async () => {
    const db = getDb();
    const { bookId } = await insertFixture(db, { cleanup: cleanupState("done") });

    await expect(caller.cleanupSelected({ bookId })).rejects.toThrow("No selected chapters need cleanup");
  });
});
