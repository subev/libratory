import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, chapters, chapterVariants } from "../schema.ts";
import { eq } from "drizzle-orm";
import { writeSyncMap } from "./sync-map.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { buildP2afLayer, buildVariantP2afLayer } from "./p2af.ts";

describe("buildP2afLayer", () => {
  let dir: string;

  beforeEach(async () => {
    await resetDb(getDb());
    dir = await mkdtemp(path.join(tmpdir(), "book-layer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists only the exported chapters of a book with no pages, since the rest would open on nothing", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Six Tales", kind: "ebook", language: "English" });
    const [front, tale, back] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const audioPath = path.join(dir, "ch000.m4a");
    await writeSyncMap(audioPath, { version: 1, totalMs: 3000, chunks: [{ text: "Once upon a midnight dreary.", startMs: 0, endMs: 3000 }] });
    await db.insert(chapters).values([
      { id: front, bookId, index: 0, title: "Imprint", rawText: "imprint", status: "suspended", selected: false },
      { id: tale, bookId, index: 1, title: "The Raven", rawText: "Once upon a midnight dreary.", status: "done", audioPath, durationMs: 3000 },
      { id: back, bookId, index: 2, title: "Colophon", rawText: "colophon", status: "suspended", selected: false },
    ]);

    const layer = await buildP2afLayer(await loadBook(bookId), new Map([[tale, { base: "ch000", audioFile: "ch000.m4a" }]]), null);

    expect(layer?.manifest.pages).toEqual([]);
    expect(layer?.manifest.chapters.map((entry) => entry.id)).toEqual([tale]);
    expect(layer?.manifest.chapters[0]).toMatchObject({ audio: "../audio/ch000.m4a", cues: "cues/ch000.json" });
    expect(layer?.cues).toHaveLength(1);
  });

  it("keeps a chapter the bilingual export chose without a narration of its own", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Six Tales", kind: "ebook", language: "English" });
    const [tale, chosen] = [crypto.randomUUID(), crypto.randomUUID()];
    const audioPath = path.join(dir, "ch000.m4a");
    await writeSyncMap(audioPath, { version: 1, totalMs: 3000, chunks: [{ text: "Once upon a midnight dreary.", startMs: 0, endMs: 3000 }] });
    await db.insert(chapters).values([
      { id: tale, bookId, index: 0, title: "The Raven", rawText: "Once upon a midnight dreary.", status: "done", audioPath, durationMs: 3000 },
      { id: chosen, bookId, index: 1, title: "Lenore", rawText: "Ah, broken is the golden bowl.", status: "suspended" },
    ]);

    const layer = await buildP2afLayer(await loadBook(bookId), new Map([[tale, { base: "ch000", audioFile: "ch000.m4a" }]]), null, [], { chapters: new Set([chosen]) });

    expect(layer?.manifest.chapters.map((entry) => entry.id)).toEqual([tale, chosen]);
    expect(layer?.manifest.chapters[1]).toMatchObject({ audio: null, cues: null });
  });
});

async function loadBook(id: string) {
  const [book] = await getDb().select().from(books).where(eq(books.id, id));
  if (!book) throw new Error("book was not inserted");
  return book;
}

describe("buildVariantP2afLayer", () => {
  let dir: string;

  beforeEach(async () => {
    await resetDb(getDb());
    dir = await mkdtemp(path.join(tmpdir(), "variant-layer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives an exported translation a layer over its own text, and leaves out what the export did not carry", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Grimm", filename: "g.pdf", pdfPath: "/tmp/g.pdf", language: "English" });
    const [narrated, skipped] = [crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(chapters).values([
      { id: narrated, bookId, index: 0, title: "The Cat and the Mouse", rawText: "a", status: "done" },
      { id: skipped, bookId, index: 1, title: "Rapunzel", rawText: "b", status: "done" },
    ]);
    const audioPath = path.join(dir, "ch000.mp3");
    await writeSyncMap(audioPath, {
      version: 1,
      totalMs: 4000,
      chunks: [{ text: "Котката и мишката.", startMs: 0, endMs: 4000 }],
    });
    await db.insert(chapterVariants).values([
      { chapterId: narrated, key: "Bulgarian", kind: "translation", title: "Котката и мишката", text: "Котката и мишката.", status: "done", audioPath, audioStatus: "done", audioDurationMs: 4000 },
      { chapterId: skipped, key: "Bulgarian", kind: "translation", title: "Рапунцел", text: "Рапунцел.", status: "done" },
    ]);
    const layer = await buildVariantP2afLayer(await loadBook(bookId), "Bulgarian", new Map([[narrated, { base: "ch000", audioFile: "ch000.mp3" }]]), null);

    expect(layer?.manifest.book.language).toBe("bg");
    expect(layer?.manifest.pages).toEqual([]);
    expect(layer?.sources).toEqual([]);
    expect(layer?.manifest.chapters).toEqual([
      expect.objectContaining({
        id: narrated,
        title: "Котката и мишката",
        audio: "../audio/ch000.mp3",
        cues: "cues/ch000.json",
        mode: "text",
        why: "generated",
      }),
    ]);
    expect(layer?.cues[0]?.doc.cues[0]?.range).toEqual([0, 18]);
  });

  it("writes no layer when nothing exported has its timings", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Grimm", filename: "g.pdf", pdfPath: "/tmp/g.pdf" });
    const chapterId = crypto.randomUUID();
    await db.insert(chapters).values({ id: chapterId, bookId, index: 0, title: "Ch", rawText: "a", status: "done" });
    await db.insert(chapterVariants).values({
      chapterId, key: "Bulgarian", kind: "translation", text: "Текст.", status: "done",
      audioPath: path.join(dir, "gone.mp3"), audioStatus: "done", audioDurationMs: 1000,
    });
    expect(await buildVariantP2afLayer(await loadBook(bookId), "Bulgarian", new Map([[chapterId, { base: "ch000", audioFile: "ch000.mp3" }]]), null)).toBeNull();
  });
});
