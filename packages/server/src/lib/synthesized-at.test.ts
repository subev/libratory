import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, chapters, chapterVariants } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { backfillSynthesizedAt } from "./synthesized-at.ts";

describe("backfillSynthesizedAt", () => {
  let dir: string;

  beforeEach(async () => {
    await resetDb(getDb());
    dir = await mkdtemp(path.join(tmpdir(), "synthesized-at-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dates old audio from its file, keeps the voice, and leaves recorded dates and missing files alone", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Old", filename: "o.pdf", pdfPath: "/tmp/o.pdf" });
    const made = new Date("2026-09-01T10:00:00.000Z");
    const oldAudio = path.join(dir, "ch000.m4a");
    const variantAudio = path.join(dir, "bg-ch000.m4a");
    for (const file of [oldAudio, variantAudio]) {
      await writeFile(file, "");
      await utimes(file, made, made);
    }
    const old = crypto.randomUUID();
    const unsnapshotted = crypto.randomUUID();
    const dated = crypto.randomUUID();
    const gone = crypto.randomUUID();
    const silent = crypto.randomUUID();
    await db.insert(chapters).values([
      { id: old, bookId, index: 0, title: "a", rawText: "x", status: "done", audioPath: oldAudio, synthesizedWith: { voice: "af_heart", speed: 1 } },
      { id: unsnapshotted, bookId, index: 1, title: "b", rawText: "x", status: "done", audioPath: oldAudio },
      { id: dated, bookId, index: 2, title: "c", rawText: "x", status: "done", audioPath: oldAudio, synthesizedWith: { voice: "af_heart", at: "2026-10-01T00:00:00.000Z" } },
      { id: gone, bookId, index: 3, title: "d", rawText: "x", status: "done", audioPath: path.join(dir, "missing.m4a") },
      { id: silent, bookId, index: 4, title: "e", rawText: "x", status: "suspended" },
    ]);
    const [variant] = await db.insert(chapterVariants).values({
      chapterId: old, key: "Bulgarian", kind: "translation", title: "а", text: "а.", status: "done",
      audioPath: variantAudio, audioStatus: "done", synthesizedWith: { voice: "bg-piper:dimitar", speed: 1 },
    }).returning({ id: chapterVariants.id });
    if (!variant) throw new Error("variant was not inserted");

    expect(await backfillSynthesizedAt()).toBe(3);

    const byId = new Map((await db.select().from(chapters).where(eq(chapters.bookId, bookId))).map((c) => [c.id, c.synthesizedWith]));
    expect(byId.get(old)).toEqual({ voice: "af_heart", speed: 1, at: made.toISOString() });
    expect(byId.get(unsnapshotted)).toEqual({ at: made.toISOString() });
    expect(byId.get(dated)).toEqual({ voice: "af_heart", at: "2026-10-01T00:00:00.000Z" });
    expect(byId.get(gone)).toBeNull();
    expect(byId.get(silent)).toBeNull();
    const [v] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, variant.id));
    expect(v?.synthesizedWith).toEqual({ voice: "bg-piper:dimitar", speed: 1, at: made.toISOString() });

    expect(await backfillSynthesizedAt()).toBe(0);
  });
});
