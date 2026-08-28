import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, ensureGraphileTables, insertJob, listJobs, row as firstRow } from "../../test/setup.ts";
import { books, chapters, chapterVariants } from "../schema.ts";
import { eq } from "drizzle-orm";

const { mockQuickAddJob } = vi.hoisted(() => ({ mockQuickAddJob: vi.fn(async () => {}) }));
vi.mock("graphile-worker", () => ({ quickAddJob: mockQuickAddJob }));

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { sweepStrandedWork } from "./sweep.ts";

async function insertFixture(db: ReturnType<typeof getDb>, opts?: { cleanText?: string | null }) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
  const chapterId = crypto.randomUUID();
  await db.insert(chapters).values({
    id: chapterId,
    bookId,
    index: 0,
    title: "Ch",
    rawText: "Some text.",
    cleanText: opts?.cleanText === undefined ? "Some clean text." : opts.cleanText,
  });
  return { bookId, chapterId };
}

describe("startup sweep", () => {
  beforeAll(async () => {
    await ensureGraphileTables(getDb());
  });

  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockClear();
  });

  it("requeues a synthesizing chapter whose job died, with resume", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.update(chapters).set({ status: "synthesizing", progress: "5/10" }).where(eq(chapters.id, chapterId));
    await insertJob(db, "synthesize", { chapterId, bookId }, { lockedAt: new Date(), attempts: 1 });

    await sweepStrandedWork();

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.status).toBe("pending");
    expect(row.progress).toBe("5/10");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "synthesize",
      { chapterId, bookId, resume: true },
      { maxAttempts: 1 },
    );
    expect(await listJobs(db)).toHaveLength(0);
  });

  it("routes stranded chapters without clean text through normalize", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db, { cleanText: null });
    await db.update(chapters).set({ status: "pending" }).where(eq(chapters.id, chapterId));

    await sweepStrandedWork();

    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "normalize",
      { chapterId, bookId },
      { maxAttempts: 1 },
    );
  });

  it("leaves chapters with a healthy queued job alone", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.update(chapters).set({ status: "pending" }).where(eq(chapters.id, chapterId));
    await insertJob(db, "synthesize", { chapterId, bookId }, { attempts: 0 });

    await sweepStrandedWork();

    expect(mockQuickAddJob).not.toHaveBeenCalled();
    expect(await listJobs(db)).toHaveLength(1);
  });

  it("does not touch done or suspended chapters", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.update(chapters).set({ status: "suspended", progress: "3/10" }).where(eq(chapters.id, chapterId));

    await sweepStrandedWork();

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.status).toBe("suspended");
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("recovers stranded translations and finished-translation audio", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const otherChapterId = crypto.randomUUID();
    await db.insert(chapters).values({ id: otherChapterId, bookId, index: 1, title: "Ch2", rawText: "More." });
    const translating = firstRow(await db
      .insert(chapterVariants)
      .values({ chapterId, key: "Bulgarian", status: "translating", text: "partial", progress: "1/3" })
      .returning());
    const audioStuck = firstRow(await db
      .insert(chapterVariants)
      .values({ chapterId: otherChapterId, key: "Bulgarian", status: "done", text: "bg", audioStatus: "synthesizing" })
      .returning());

    await sweepStrandedWork();

    const t = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translating.id)));
    expect(t.status).toBe("pending");
    expect(t.text).toBe("partial");
    const a = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, audioStuck.id)));
    expect(a.audioStatus).toBe("pending");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "translate",
      { translationId: translating.id, bookId },
      { maxAttempts: 1 },
    );
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "synthesizeTranslation",
      { translationId: audioStuck.id, bookId, resume: true },
      { maxAttempts: 1 },
    );
  });

  it("leaves deferred audio markers to the translate worker", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    const row = firstRow(await db
      .insert(chapterVariants)
      .values({ chapterId, key: "Bulgarian", status: "translating", text: "", audioStatus: "pending" })
      .returning());

    await sweepStrandedWork();

    const t = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, row.id)));
    expect(t.audioStatus).toBe("pending");
    expect(mockQuickAddJob).toHaveBeenCalledWith(expect.anything(), "translate", expect.anything(), expect.anything());
    expect(mockQuickAddJob).not.toHaveBeenCalledWith(expect.anything(), "synthesizeTranslation", expect.anything(), expect.anything());
  });

  it("requeues a stranded cleanup and clears its error", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const now = new Date().toISOString();
    await db
      .update(chapters)
      .set({ status: "done", cleanup: { status: "cleaning", progress: "2/5", error: "old", createdAt: now, updatedAt: now } })
      .where(eq(chapters.id, chapterId));
    await insertJob(db, "cleanup", { chapterId, bookId }, { lockedAt: new Date(), attempts: 1 });

    await sweepStrandedWork();

    const row = firstRow(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(row.cleanup?.status).toBe("pending");
    expect(row.cleanup?.error).toBeUndefined();
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "cleanup",
      { chapterId, bookId },
      { maxAttempts: 1 },
    );
    expect(await listJobs(db)).toHaveLength(0);
  });

  it("leaves healthy queued cleanups and finished cleanups alone", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const now = new Date().toISOString();
    await db
      .update(chapters)
      .set({ status: "done", cleanup: { status: "pending", createdAt: now, updatedAt: now } })
      .where(eq(chapters.id, chapterId));
    await insertJob(db, "cleanup", { chapterId, bookId }, { attempts: 0 });

    const { chapterId: doneChapterId } = await insertFixture(db);
    await db
      .update(chapters)
      .set({ status: "done", cleanup: { status: "done", createdAt: now, updatedAt: now } })
      .where(eq(chapters.id, doneChapterId));

    await sweepStrandedWork();

    expect(mockQuickAddJob).not.toHaveBeenCalledWith(expect.anything(), "cleanup", expect.anything(), expect.anything());
    const done = firstRow(await db.select().from(chapters).where(eq(chapters.id, doneChapterId)));
    expect(done.cleanup?.status).toBe("done");
  });

  it("marks a stranded chapter proposal failed instead of re-running it", async () => {
    const db = getDb();
    const { bookId } = await insertFixture(db);
    await db.update(books).set({
      chapterProposal: { status: "running", method: "llm", createdAt: new Date().toISOString() },
    }).where(eq(books.id, bookId));
    await insertJob(db, "propose", { bookId, method: "llm" }, { lockedAt: new Date(), attempts: 1 });

    await sweepStrandedWork();

    const row = firstRow(await db.select().from(books).where(eq(books.id, bookId)));
    expect(row.chapterProposal?.status).toBe("failed");
    expect(row.chapterProposal?.error).toContain("server restart");
    expect(mockQuickAddJob).not.toHaveBeenCalledWith(expect.anything(), "propose", expect.anything(), expect.anything());
  });

  it("marks a stranded book note job failed", async () => {
    const db = getDb();
    const { bookId } = await insertFixture(db);
    const now = new Date().toISOString();
    await db.update(books).set({
      noteJob: { status: "running", prompt: "Summarize", model: "flash", createdAt: now, updatedAt: now },
    }).where(eq(books.id, bookId));
    await insertJob(db, "bookNote", { bookId, prompt: "Summarize", model: "flash" }, { lockedAt: new Date(), attempts: 1 });

    await sweepStrandedWork();

    const row = firstRow(await db.select().from(books).where(eq(books.id, bookId)));
    expect(row.noteJob?.status).toBe("failed");
    expect(row.noteJob?.error).toContain("server restart");
  });

  it("replays dead assemble jobs and unsticks assembling books without one", async () => {
    const db = getDb();
    const { bookId } = await insertFixture(db);
    await db.update(books).set({ status: "assembling" }).where(eq(books.id, bookId));
    await insertJob(db, "assemble", { bookId, language: "Bulgarian" }, { attempts: 1 });

    const stuckBookId = crypto.randomUUID();
    await db.insert(books).values({ id: stuckBookId, title: "B2", filename: "c.pdf", pdfPath: "/tmp/c.pdf", status: "assembling" });

    await sweepStrandedWork();

    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "assemble",
      { bookId, language: "Bulgarian" },
      { maxAttempts: 1 },
    );
    const replayed = firstRow(await db.select().from(books).where(eq(books.id, bookId)));
    expect(replayed.status).toBe("assembling");
    const unstuck = firstRow(await db.select().from(books).where(eq(books.id, stuckBookId)));
    expect(unstuck.status).toBe("done");
  });
});
