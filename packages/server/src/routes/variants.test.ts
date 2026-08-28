import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, ensureGraphileTables, row as firstRow } from "../../test/setup.ts";
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

import { variantsRouter } from "./variants.ts";

const caller = variantsRouter.createCaller({});

async function insertFixture(db: ReturnType<typeof getDb>) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
  const chapterId = crypto.randomUUID();
  await db.insert(chapters).values({ id: chapterId, bookId, index: 0, title: "Ch", rawText: "Some text." });
  return { bookId, chapterId };
}

describe("variants router", () => {
  // stop() clears queued jobs from the graphile-worker queue, which only exists once a worker has run
  beforeAll(async () => {
    await ensureGraphileTables(getDb());
  });

  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockClear();
  });

  it("start creates a row, stores the book language, and enqueues a job", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);

    const row = await caller.start({ chapterId, key: "Bulgarian" });

    expect(row?.status).toBe("pending");
    expect(row?.key).toBe("Bulgarian");
    expect(row?.kind).toBe("translation");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "translate",
      { translationId: row!.id, bookId },
      { maxAttempts: 1 },
    );
    const book = firstRow(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.translationLanguage).toBe("Bulgarian");
  });

  it("start rejects when a fresh translation is already running", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({ chapterId, key: "Bulgarian", status: "translating" });

    await expect(caller.start({ chapterId, key: "Bulgarian" })).rejects.toThrow("already running");
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("start resumes a suspended translation keeping its text", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({
      chapterId,
      key: "Bulgarian",
      status: "suspended",
      text: "partial",
      progress: "1/3",
    });

    const row = await caller.start({ chapterId, key: "Bulgarian" });

    expect(row?.status).toBe("pending");
    expect(row?.text).toBe("partial");
    expect(row?.progress).toBe("1/3");
  });

  it("start with restart clears previous text", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({
      chapterId,
      key: "Bulgarian",
      status: "suspended",
      text: "partial",
      progress: "1/3",
    });

    const row = await caller.start({ chapterId, key: "Bulgarian", restart: true });

    expect(row?.text).toBe("");
    expect(row?.progress).toBeNull();
  });

  it("start with restart clears the translated title", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({
      chapterId,
      key: "Bulgarian",
      status: "done",
      text: "done text",
      title: "Стара глава",
    });

    const row = await caller.start({ chapterId, key: "Bulgarian", restart: true });

    expect(row?.title).toBeNull();
  });

  it("translateMissingTitles queues a job when finished translations lack titles", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({ chapterId, key: "Bulgarian", status: "done", text: "done text" });

    const result = await caller.translateMissingTitles({ bookId, key: "Bulgarian" });

    expect(result.queued).toBe(1);
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "translateTitles",
      { bookId, language: "Bulgarian" },
      expect.objectContaining({ maxAttempts: 1 }),
    );
  });

  it("translateMissingTitles rejects when no titles are missing", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({ chapterId, key: "Bulgarian", status: "done", text: "t", title: "Заглавие" });

    await expect(caller.translateMissingTitles({ bookId, key: "Bulgarian" })).rejects.toThrow(/missing a title/);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("stop suspends a running translation and clears queued jobs", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({ chapterId, key: "Bulgarian", status: "translating" });

    const row = await caller.stop({ chapterId, key: "Bulgarian" });

    expect(row?.status).toBe("suspended");
  });

  it("stop is a no-op for a finished translation", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({ chapterId, key: "Bulgarian", status: "done", text: "done text" });

    const row = await caller.stop({ chapterId, key: "Bulgarian" });

    expect(row).toBeNull();
    const kept = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.chapterId, chapterId)));
    expect(kept.status).toBe("done");
  });

  it("queueAudio enqueues synthesis for a finished translation", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const variant = firstRow(await db
      .insert(chapterVariants)
      .values({ chapterId, key: "Bulgarian", status: "done", text: "bg text" })
      .returning());

    const updated = await caller.queueAudio({ chapterId, key: "Bulgarian" });

    expect(updated?.audioStatus).toBe("pending");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "synthesizeTranslation",
      { translationId: variant.id, bookId, resume: false },
      { maxAttempts: 1 },
    );
  });

  it("queueAudio rejects unfinished translations", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({ chapterId, key: "Bulgarian", status: "suspended", text: "partial" });

    await expect(caller.queueAudio({ chapterId, key: "Bulgarian" })).rejects.toThrow("not finished");
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("processSelected queues selected chapters without a finished translation", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const doneId = crypto.randomUUID();
    await db.insert(chapters).values({ id: doneId, bookId, index: 1, title: "Ch2", rawText: "Second." });
    const suspendedId = crypto.randomUUID();
    await db.insert(chapters).values({ id: suspendedId, bookId, index: 2, title: "Ch3", rawText: "Third." });
    const unselectedId = crypto.randomUUID();
    await db.insert(chapters).values({ id: unselectedId, bookId, index: 3, title: "Ch4", rawText: "Fourth.", selected: false });

    await db.insert(chapterVariants).values([
      { chapterId: doneId, key: "Bulgarian", status: "done", text: "bg" },
      { chapterId: suspendedId, key: "Bulgarian", status: "suspended", text: "partial", progress: "1/3" },
    ]);

    const result = await caller.processSelected({ bookId, key: "Bulgarian" });

    expect(result.queued).toBe(2);
    expect(mockQuickAddJob).toHaveBeenCalledTimes(2);
    const created = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.chapterId, chapterId)));
    expect(created.status).toBe("pending");
    const resumed = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.chapterId, suspendedId)));
    expect(resumed.status).toBe("pending");
    expect(resumed.text).toBe("partial");
    const book = firstRow(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.translationLanguage).toBe("Bulgarian");
  });

  it("processSelected leaves a fresh running translation alone", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({ chapterId, key: "Bulgarian", status: "translating" });

    await expect(caller.processSelected({ bookId, key: "Bulgarian" })).rejects.toThrow("No selected chapters");
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("processSelectedAudio queues only selected chapters with finished translations", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const otherChapterId = crypto.randomUUID();
    await db.insert(chapters).values({ id: otherChapterId, bookId, index: 1, title: "Ch2", rawText: "More text.", selected: false });
    const unselectedDoneId = crypto.randomUUID();
    await db.insert(chapters).values({ id: unselectedDoneId, bookId, index: 2, title: "Ch3", rawText: "Third.", selected: true });

    await db.insert(chapterVariants).values([
      { chapterId, key: "Bulgarian", status: "done", text: "bg" },
      { chapterId: otherChapterId, key: "Bulgarian", status: "done", text: "bg2" },
      { chapterId: unselectedDoneId, key: "Bulgarian", status: "suspended", text: "partial" },
    ]);

    const result = await caller.processSelectedAudio({ bookId, key: "Bulgarian" });

    expect(result.queued).toBe(1);
    expect(mockQuickAddJob).toHaveBeenCalledTimes(1);
  });

  it("processSelectedAudio marks still-translating chapters pending without enqueueing a job", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const doneId = crypto.randomUUID();
    await db.insert(chapters).values({ id: doneId, bookId, index: 1, title: "Ch2", rawText: "Second." });

    await db.insert(chapterVariants).values([
      { chapterId, key: "Bulgarian", status: "translating", text: "partial" },
      { chapterId: doneId, key: "Bulgarian", status: "done", text: "bg" },
    ]);

    const result = await caller.processSelectedAudio({ bookId, key: "Bulgarian" });

    expect(result.queued).toBe(2);
    expect(result.deferred).toBe(1);
    expect(mockQuickAddJob).toHaveBeenCalledTimes(1);
    const translating = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.chapterId, chapterId)));
    expect(translating.audioStatus).toBe("pending");
    expect(translating.status).toBe("translating");
  });

  it("stopAudio suspends running audio and reports the count", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({
      chapterId,
      key: "Bulgarian",
      status: "done",
      text: "bg",
      audioStatus: "synthesizing",
    });

    const result = await caller.stopAudio({ bookId, key: "Bulgarian" });

    expect(result.stopped).toBe(1);
    const stopped = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.chapterId, chapterId)));
    expect(stopped.audioStatus).toBe("suspended");
  });

  it("list aggregates per-variant counts with kind and label", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values([
      { chapterId, key: "Bulgarian", status: "done", text: "bg" },
      { chapterId, key: "eli5", kind: "transform", label: "ELI5", prompt: "Explain simply.", status: "translating" },
    ]);

    const result = await caller.list({ bookId });

    expect(result).toEqual([
      { key: "Bulgarian", kind: "translation", label: null, total: 1, done: 1 },
      { key: "eli5", kind: "transform", label: "ELI5", total: 1, done: 0 },
    ]);
  });

  it("get returns the row and listForBook filters by key", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values([
      { chapterId, key: "Bulgarian", status: "done", text: "bg" },
      { chapterId, key: "German", status: "pending" },
    ]);

    const row = await caller.get({ chapterId, key: "Bulgarian" });
    expect(row?.text).toBe("bg");

    const list = await caller.listForBook({ bookId, key: "Bulgarian" });
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe("Bulgarian");
  });

  it("listForBook counts words in the translated text", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const emptyId = crypto.randomUUID();
    await db.insert(chapters).values({ id: emptyId, bookId, index: 1, title: "Ch2", rawText: "Second." });
    await db.insert(chapterVariants).values([
      { chapterId, key: "Bulgarian", status: "done", text: "Приятелството на котката и мишката" },
      { chapterId: emptyId, key: "Bulgarian", status: "pending", text: "" },
    ]);

    const list = await caller.listForBook({ bookId, key: "Bulgarian" });

    const byChapter = new Map(list.map((r) => [r.chapterId, r.wordCount]));
    expect(byChapter.get(chapterId)).toBe(5);
    expect(byChapter.get(emptyId)).toBe(0);
  });

  it("createTransform snapshots the prompt and queues the translate job", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);

    const row = await caller.createTransform({ chapterId, presetId: "eli5", prompt: "Explain it simply." });

    expect(row?.key).toBe("eli5");
    expect(row?.kind).toBe("transform");
    expect(row?.label).toBe("ELI5");
    expect(row?.prompt).toBe("Explain it simply.");
    expect(row?.params?.mode).toBe("chunked");
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.anything(),
      "translate",
      { translationId: row!.id, bookId },
      { maxAttempts: 1 },
    );
    const book = firstRow(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.translationLanguage).toBe("eli5");
  });

  it("createTransform on an existing lane resets the row with the new prompt", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);
    await db.insert(chapterVariants).values({
      chapterId,
      key: "eli5",
      kind: "transform",
      label: "ELI5",
      prompt: "Old prompt.",
      status: "done",
      text: "old text",
      title: "Ch",
    });

    const row = await caller.createTransform({ chapterId, presetId: "eli5", prompt: "New prompt." });

    expect(row?.prompt).toBe("New prompt.");
    expect(row?.text).toBe("");
    expect(row?.status).toBe("pending");
  });

  it("createTransform slugs a custom label into the key", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);

    const row = await caller.createTransform({ chapterId, prompt: "Add proofs everywhere.", label: "With Proofs" });

    expect(row?.key).toBe("custom-with-proofs");
    expect(row?.label).toBe("With Proofs");
  });

  it("start stores the thinking flag in params and updates it on retry", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);

    const row = await caller.start({ chapterId, key: "Bulgarian", thinking: true });
    expect(row?.params?.thinking).toBe(true);

    await db.update(chapterVariants).set({ status: "failed", updatedAt: new Date(0) }).where(eq(chapterVariants.id, row!.id));
    const retried = await caller.start({ chapterId, key: "Bulgarian", thinking: false });
    expect(retried?.params?.thinking).toBe(false);
  });

  it("start on a preset key without siblings resolves the preset spec", async () => {
    const db = getDb();
    const { chapterId } = await insertFixture(db);

    const row = await caller.start({ chapterId, key: "summary" });

    expect(row?.kind).toBe("transform");
    expect(row?.label).toBe("Summary");
    expect(row?.prompt).toBeTruthy();
    expect(row?.params?.mode).toBe("whole");
  });

  it("processSelected clones the transform spec from a sibling row", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const secondId = crypto.randomUUID();
    await db.insert(chapters).values({ id: secondId, bookId, index: 1, title: "Ch2", rawText: "Second." });
    await db.insert(chapterVariants).values({
      chapterId,
      key: "custom-noir",
      kind: "transform",
      label: "Noir",
      prompt: "Rewrite as noir.",
      params: { temperature: 0.9, mode: "chunked" },
      status: "done",
      text: "noir text",
    });

    const result = await caller.processSelected({ bookId, key: "custom-noir" });

    expect(result.queued).toBe(1);
    const cloned = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.chapterId, secondId)));
    expect(cloned.kind).toBe("transform");
    expect(cloned.label).toBe("Noir");
    expect(cloned.prompt).toBe("Rewrite as noir.");
  });

  it("processSelected rejects an unknown custom key", async () => {
    const db = getDb();
    const { bookId } = await insertFixture(db);

    await expect(caller.processSelected({ bookId, key: "custom-ghost" })).rejects.toThrow(/copy the prompt/);
  });

  it("setVoice stores a per-variant voice and merges partial updates", async () => {
    const db = getDb();
    const { bookId } = await insertFixture(db);

    await caller.setVoice({ bookId, key: "Bulgarian", voice: "bg-mlx:narrator" });
    await caller.setVoice({ bookId, key: "Bulgarian", speed: 1.2 });
    await caller.setVoice({ bookId, key: "eli5", voice: "af_bella" });

    const book = firstRow(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.variantVoices).toEqual({
      Bulgarian: { voice: "bg-mlx:narrator", speed: 1.2 },
      eli5: { voice: "af_bella" },
    });
    expect(book.voice).toBe("af_heart");
  });

  it("setVoice rejects unknown voice ids", async () => {
    const db = getDb();
    const { bookId } = await insertFixture(db);

    await expect(caller.setVoice({ bookId, key: "Bulgarian", voice: "not-a-voice" })).rejects.toThrow(/Unsupported voice/);
  });
});
