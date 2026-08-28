import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, chapters, chapterVariants } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { deferUntilInputsSettle, inFlightInputs } from "./output-readiness.ts";

type ChapterSpec = { status: "pending" | "normalizing" | "synthesizing" | "done" | "failed" | "suspended"; selected?: boolean };

async function insertBook(specs: ChapterSpec[]) {
  const db = getDb();
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
  await db.insert(chapters).values(specs.map((spec, index) => ({
    bookId,
    index,
    title: `Chapter ${index}`,
    rawText: "text",
    status: spec.status,
    selected: spec.selected ?? true,
  })));
  return bookId;
}

describe("inFlightInputs", () => {
  beforeEach(async () => { await resetDb(getDb()); });

  it("counts selected chapters that are still producing audio", async () => {
    const bookId = await insertBook([
      { status: "done" },
      { status: "synthesizing" },
      { status: "pending" },
      { status: "normalizing" },
    ]);
    expect(await inFlightInputs(bookId, null, "audio")).toBe(3);
  });

  it("ignores unselected chapters", async () => {
    const bookId = await insertBook([{ status: "done" }, { status: "pending", selected: false }]);
    expect(await inFlightInputs(bookId, null, "audio")).toBe(0);
  });

  it("treats failed and suspended chapters as settled", async () => {
    const bookId = await insertBook([{ status: "done" }, { status: "failed" }, { status: "suspended" }]);
    expect(await inFlightInputs(bookId, null, "audio")).toBe(0);
  });

  it("never waits on text in the original view", async () => {
    const bookId = await insertBook([{ status: "pending" }, { status: "synthesizing" }]);
    expect(await inFlightInputs(bookId, null, "text")).toBe(0);
  });

  it("follows variant audio status in a language view", async () => {
    const db = getDb();
    const bookId = await insertBook([{ status: "done" }, { status: "done" }]);
    const rows = await db.select({ id: chapters.id }).from(chapters);
    await db.insert(chapterVariants).values([
      { chapterId: row(rows).id, key: "Bulgarian", text: "t", status: "done", audioStatus: "done" },
      { chapterId: row(rows, 1).id, key: "Bulgarian", text: "t", status: "done", audioStatus: "synthesizing" },
    ]);
    expect(await inFlightInputs(bookId, "Bulgarian", "audio")).toBe(1);
    expect(await inFlightInputs(bookId, "Bulgarian", "text")).toBe(0);
  });
});

describe("deferUntilInputsSettle", () => {
  beforeEach(async () => { await resetDb(getDb()); });

  const run = async (bookId: string, payload: Record<string, unknown> = {}) => {
    const addJob = vi.fn(async () => ({}) as any);
    const deferred = await deferUntilInputsSettle({
      identifier: "assembleDocument",
      payload: { bookId, format: "epub-sync", ...payload },
      jobKey: `assembleDocument:${bookId}:epub-sync:original`,
      language: null,
      needs: "audio",
      addJob,
      log: async () => {},
    });
    return { deferred, addJob };
  };

  it("re-queues itself while chapters are still synthesizing", async () => {
    const bookId = await insertBook([{ status: "done" }, { status: "synthesizing" }]);
    const { deferred, addJob } = await run(bookId);

    expect(deferred).toBe(true);
    expect(addJob).toHaveBeenCalledTimes(1);
    const [identifier, payload, spec] = addJob.mock.calls[0] as any[];
    expect(identifier).toBe("assembleDocument");
    expect(payload.waitingSince).toEqual(expect.any(String));
    expect(spec.jobKey).toBe(`assembleDocument:${bookId}:epub-sync:original`);
    expect(spec.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("carries the original wait start across reschedules", async () => {
    const bookId = await insertBook([{ status: "pending" }]);
    const waitingSince = new Date(Date.now() - 60_000).toISOString();
    const { addJob } = await run(bookId, { waitingSince });
    expect((addJob.mock.calls[0] as any[])[1].waitingSince).toBe(waitingSince);
  });

  it("lets the job through once nothing is in flight", async () => {
    const bookId = await insertBook([{ status: "done" }, { status: "failed" }]);
    const { deferred, addJob } = await run(bookId);
    expect(deferred).toBe(false);
    expect(addJob).not.toHaveBeenCalled();
  });

  it("gives up after a day so a stalled queue can't reschedule forever", async () => {
    const bookId = await insertBook([{ status: "pending" }]);
    const waitingSince = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { deferred, addJob } = await run(bookId, { waitingSince });
    expect(deferred).toBe(false);
    expect(addJob).not.toHaveBeenCalled();
  });
});
