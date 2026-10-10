import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, chapters, chapterVariants, documents, DEFAULT_PROFILE_ID } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { backfillDocumentNarration } from "./document-narration.ts";

async function recording(dir: string, name: string, totalMs: number, words: boolean) {
  const audioPath = path.join(dir, `${name}.m4a`);
  const chunk = words
    ? { text: "One two.", startMs: 0, endMs: totalMs, words: [{ text: "One", after: " ", startMs: 0, endMs: 10 }, { text: "two.", after: "", startMs: 10, endMs: totalMs }] }
    : { text: "One two.", startMs: 0, endMs: totalMs };
  await writeFile(audioPath.replace(".m4a", ".sync.json"), JSON.stringify({ version: 2, totalMs, chunks: [chunk] }));
  return audioPath;
}

beforeEach(async () => {
  await resetDb(getDb());
});

describe("backfillDocumentNarration", () => {
  it("fills older read-along and bilingual rows from their chapters' sync maps, once", async () => {
    const db = getDb();
    const dir = await mkdtemp(path.join(os.tmpdir(), "backfill-"));
    const book = row(await db.insert(books).values({ title: "Der Prozess", language: "de", profileId: DEFAULT_PROFILE_ID }).returning());
    const ch = row(
      await db
        .insert(chapters)
        .values({ bookId: book.id, index: 0, title: "I", rawText: "One two.", status: "done", audioPath: await recording(dir, "ch000", 4000, true), durationMs: 4000, synthesizedWith: { voice: "kokoro:af_heart" } })
        .returning(),
    );
    await db.insert(chapterVariants).values({
      chapterId: ch.id, key: "English", kind: "translation", status: "done", text: "One two.",
      audioStatus: "done", audioPath: await recording(dir, "en000", 6000, false), audioDurationMs: 6000, synthesizedWith: { voice: "say:samantha" },
    });
    const base = { bookId: book.id, chapterCount: 1, chapterSummary: "1", chapterIds: JSON.stringify([ch.id]) };
    const sync = row(await db.insert(documents).values({ ...base, format: "epub-sync", outputPath: path.join(dir, "a_readaloud_20261010_091200.epub") }).returning());
    const translated = row(await db.insert(documents).values({ ...base, format: "epub-sync", language: "English", outputPath: path.join(dir, "a_english_readaloud_20261010_091200.epub") }).returning());
    const bilingual = row(
      await db.insert(documents).values({ ...base, format: "epub-bilingual", language: "English", outputPath: path.join(dir, "a_bilingual_de-english_audio-original-english_20261010_091200.epub") }).returning(),
    );
    const textOnly = row(
      await db.insert(documents).values({ ...base, format: "epub-bilingual", language: "English", outputPath: path.join(dir, "a_bilingual_de-english_audio-none_20261010_091200.epub") }).returning(),
    );
    const pdf = row(await db.insert(documents).values({ ...base, format: "pdf", outputPath: path.join(dir, "a.pdf") }).returning());

    expect(await backfillDocumentNarration()).toBe(4);
    const narrationOf = async (id: string) => (await db.select({ n: documents.narration }).from(documents).where(eq(documents.id, id)))[0]?.n;
    expect(await narrationOf(sync.id)).toEqual({ original: { level: "word", durationMs: 4000, voice: "Heart" }, translation: null });
    expect(await narrationOf(translated.id)).toEqual({ original: null, translation: { level: "chunk", durationMs: 6000, voice: "Samantha" } });
    expect(await narrationOf(bilingual.id)).toEqual({
      original: { level: "word", durationMs: 4000, voice: "Heart" },
      translation: { level: "chunk", durationMs: 6000, voice: "Samantha" },
    });
    expect(await narrationOf(textOnly.id)).toEqual({ original: null, translation: null });
    expect(await narrationOf(pdf.id)).toBeNull();

    expect(await backfillDocumentNarration()).toBe(0);
  });
});
