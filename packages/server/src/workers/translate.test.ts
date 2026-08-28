import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row as firstRow } from "../../test/setup.ts";
import { books, chapters, chapterVariants } from "../schema.ts";
import { eq } from "drizzle-orm";

vi.mock("../lib/translate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/translate.ts")>();
  return { ...actual, translateChunk: vi.fn(), translateTitle: vi.fn() };
});

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { translate } from "./translate.ts";
import { translateChunk, translateTitle } from "../lib/translate.ts";
import { splitIntoChunks } from "../lib/transform.ts";
import { subscribeTranslationLive, type TranslationLiveEvent } from "../lib/translate-live.ts";
import { createHash } from "node:crypto";

const mockTranslateChunk = vi.mocked(translateChunk);
const mockTranslateTitle = vi.mocked(translateTitle);
const mockAddJob = vi.fn(async () => {});
const helpers = { addJob: mockAddJob as never };

const PARA = "One sentence here. ".repeat(60).trim();
const SOURCE = [PARA, PARA, PARA].join("\n\n");

const SOURCE_HASH = createHash("sha256").update(SOURCE).digest("hex");

async function insertFixture(
  db: ReturnType<typeof getDb>,
  opts?: { status?: "pending" | "suspended"; text?: string; progress?: string; sourceHash?: string; params?: { thinking?: boolean } },
) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
  const chapterId = crypto.randomUUID();
  await db.insert(chapters).values({ id: chapterId, bookId, index: 0, title: "Ch", rawText: SOURCE });
  const row = firstRow(await db
    .insert(chapterVariants)
    .values({
      chapterId,
      key: "Bulgarian",
      status: opts?.status ?? "pending",
      text: opts?.text ?? "",
      progress: opts?.progress,
      sourceHash: opts?.sourceHash,
      params: opts?.params,
    })
    .returning());
  return { bookId, chapterId, translationId: row.id };
}

describe("translate worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockTranslateChunk.mockReset();
    mockTranslateTitle.mockReset();
    mockTranslateTitle.mockResolvedValue("Глава");
    mockAddJob.mockClear();
  });

  it("translates all chunks and accumulates text", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    mockTranslateChunk.mockImplementation(async ({ text }) => `BG(${text.slice(0, 10)})`);

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.status).toBe("done");
    expect(row.progress).toBe(`${total}/${total}`);
    expect(row.text.split("\n\n")).toHaveLength(total);
    expect(mockTranslateChunk).toHaveBeenCalledTimes(total);
  });

  it("stops mid-run and keeps completed chunks when suspended", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    expect(total).toBeGreaterThan(1);

    let calls = 0;
    mockTranslateChunk.mockImplementation(async () => {
      calls++;
      if (calls === 2) {
        await db
          .update(chapterVariants)
          .set({ status: "suspended" })
          .where(eq(chapterVariants.id, translationId));
      }
      return `BG-${calls}`;
    });

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.status).toBe("suspended");
    expect(row.text).toBe("BG-1");
    expect(row.progress).toBe(`1/${total}`);
    expect(mockTranslateChunk).toHaveBeenCalledTimes(2);
  });

  it("resumes from saved progress without re-translating done chunks", async () => {
    const db = getDb();
    const total = splitIntoChunks(SOURCE).length;
    const { bookId, translationId } = await insertFixture(db, {
      text: "BG-DONE-1",
      progress: `1/${total}`,
      sourceHash: SOURCE_HASH,
    });
    mockTranslateChunk.mockImplementation(async () => "BG-NEW");

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.status).toBe("done");
    expect(row.text.startsWith("BG-DONE-1")).toBe(true);
    expect(mockTranslateChunk).toHaveBeenCalledTimes(total - 1);
  });

  it("starts over when saved progress no longer matches the chunking", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db, { text: "STALE", progress: "1/999", sourceHash: SOURCE_HASH });
    mockTranslateChunk.mockImplementation(async () => "BG");

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.status).toBe("done");
    expect(row.text.includes("STALE")).toBe(false);
    expect(mockTranslateChunk).toHaveBeenCalledTimes(splitIntoChunks(SOURCE).length);
  });

  it("starts over when the source text changed since the partial was made", async () => {
    const db = getDb();
    const total = splitIntoChunks(SOURCE).length;
    const { bookId, translationId } = await insertFixture(db, {
      text: "OLD-SOURCE-PARTIAL",
      progress: `1/${total}`,
      sourceHash: "hash-of-the-old-text",
    });
    mockTranslateChunk.mockImplementation(async () => "BG");

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.status).toBe("done");
    expect(row.text.includes("OLD-SOURCE-PARTIAL")).toBe(false);
    expect(row.sourceHash).toBe(SOURCE_HASH);
    expect(mockTranslateChunk).toHaveBeenCalledTimes(total);
  });

  it("does nothing when the translation was suspended before start", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db, { status: "suspended" });

    await translate({ translationId, bookId }, helpers);

    expect(mockTranslateChunk).not.toHaveBeenCalled();
    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.status).toBe("suspended");
  });

  it("enqueues synthesis on completion when audio was queued mid-translation", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    await db
      .update(chapterVariants)
      .set({ audioStatus: "pending" })
      .where(eq(chapterVariants.id, translationId));
    mockTranslateChunk.mockImplementation(async () => "BG");

    await translate({ translationId, bookId }, helpers);

    expect(mockAddJob).toHaveBeenCalledWith(
      "synthesizeTranslation",
      { translationId, bookId },
      { maxAttempts: 1 },
    );
  });

  it("does not enqueue synthesis when no audio was queued", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    mockTranslateChunk.mockImplementation(async () => "BG");

    await translate({ translationId, bookId }, helpers);

    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it("translates the chapter title with the translated opening as context", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    mockTranslateChunk.mockImplementation(async () => "BG");

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.title).toBe("Глава");
    expect(mockTranslateTitle).toHaveBeenCalledWith({
      title: "Ch",
      language: "Bulgarian",
      translatedOpening: expect.stringContaining("BG"),
      thinking: false,
    });
  });

  it("passes the lane's thinking param to the chunk translator", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db, { params: { thinking: true } });
    mockTranslateChunk.mockImplementation(async () => "BG");

    await translate({ translationId, bookId }, helpers);

    expect(mockTranslateChunk).toHaveBeenCalledWith(expect.objectContaining({ thinking: true }));
    expect(mockTranslateTitle).toHaveBeenCalledWith(expect.objectContaining({ thinking: true }));
  });

  it("keeps an existing title when resuming", async () => {
    const db = getDb();
    const total = splitIntoChunks(SOURCE).length;
    const { bookId, translationId } = await insertFixture(db, {
      text: "BG-DONE-1",
      progress: `1/${total}`,
      sourceHash: SOURCE_HASH,
    });
    await db.update(chapterVariants).set({ title: "Стара глава" }).where(eq(chapterVariants.id, translationId));
    mockTranslateChunk.mockImplementation(async () => "BG");

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.title).toBe("Стара глава");
    expect(mockTranslateTitle).not.toHaveBeenCalled();
  });

  it("stops writing when a newer run takes over the row", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    const total = splitIntoChunks(SOURCE).length;
    expect(total).toBeGreaterThan(1);

    let calls = 0;
    mockTranslateChunk.mockImplementation(async () => {
      calls++;
      if (calls === 2) {
        await db
          .update(chapterVariants)
          .set({ runToken: "newer-run" })
          .where(eq(chapterVariants.id, translationId));
      }
      return `BG-${calls}`;
    });

    await translate({ translationId, bookId }, helpers);

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.text).toBe("BG-1");
    expect(row.runToken).toBe("newer-run");
    expect(mockTranslateChunk).toHaveBeenCalledTimes(2);
  });

  it("publishes live deltas while streaming and a done status at the end", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    mockTranslateChunk.mockImplementation(async ({ text, onDelta, onThinking }) => {
      onThinking?.("pondering names...");
      onDelta?.("BG(");
      onDelta?.(text.slice(0, 5));
      onDelta?.(")");
      return `BG(${text.slice(0, 5)})`;
    });

    const events: TranslationLiveEvent[] = [];
    const unsubscribe = subscribeTranslationLive(translationId, (e) => events.push(e));
    await translate({ translationId, bookId }, helpers);
    unsubscribe();

    expect(events[0]).toEqual({ type: "snapshot", text: "" });
    expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "thinking").length).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: "status", status: "done" });

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    const streamed = events.reduce(
      (text, e) => (e.type === "snapshot" ? e.text : e.type === "delta" ? text + e.text : text),
      "",
    );
    expect(streamed).toBe(row.text);
  });

  it("publishes a failed status with the error when the provider throws", async () => {
    const { bookId, translationId } = await insertFixture(getDb());
    mockTranslateChunk.mockRejectedValue(new Error("API down"));

    const events: TranslationLiveEvent[] = [];
    const unsubscribe = subscribeTranslationLive(translationId, (e) => events.push(e));
    await expect(translate({ translationId, bookId }, helpers)).rejects.toThrow("API down");
    unsubscribe();

    expect(events.at(-1)).toEqual({ type: "status", status: "failed", error: "API down" });
  });

  it("marks the row failed when the provider throws", async () => {
    const db = getDb();
    const { bookId, translationId } = await insertFixture(db);
    mockTranslateChunk.mockRejectedValue(new Error("API down"));

    await expect(translate({ translationId, bookId }, helpers)).rejects.toThrow("API down");

    const row = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId)));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("API down");
  });
});
