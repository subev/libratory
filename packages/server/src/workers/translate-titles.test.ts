import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row as firstRow } from "../../test/setup.ts";
import { books, chapters, chapterVariants } from "../schema.ts";
import { eq } from "drizzle-orm";

vi.mock("../lib/translate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/translate.ts")>();
  return { ...actual, translateTitle: vi.fn() };
});

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { translateTitles } from "./translate-titles.ts";
import { translateTitle } from "../lib/translate.ts";

const mockTranslateTitle = vi.mocked(translateTitle);

async function insertFixture(db: ReturnType<typeof getDb>) {
  const bookId = crypto.randomUUID();
  await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
  const chapterId = crypto.randomUUID();
  await db.insert(chapters).values({ id: chapterId, bookId, index: 0, title: "Ch", rawText: "Some text." });
  return { bookId, chapterId };
}

describe("translateTitles worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockTranslateTitle.mockReset();
  });

  it("fills in titles for finished translations that lack one", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const row = firstRow(await db
      .insert(chapterVariants)
      .values({ chapterId, key: "Bulgarian", status: "done", text: "Преведен текст." })
      .returning());
    mockTranslateTitle.mockResolvedValue("Глава");

    await translateTitles({ bookId, language: "Bulgarian" });

    const updated = firstRow(await db.select().from(chapterVariants).where(eq(chapterVariants.id, row.id)));
    expect(updated.title).toBe("Глава");
    expect(mockTranslateTitle).toHaveBeenCalledWith({
      title: "Ch",
      language: "Bulgarian",
      translatedOpening: "Преведен текст.",
    });
  });

  it("skips unfinished translations and ones that already have a title", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const chapterId2 = crypto.randomUUID();
    await db.insert(chapters).values({ id: chapterId2, bookId, index: 1, title: "Ch2", rawText: "More text." });
    await db.insert(chapterVariants).values([
      { chapterId, key: "Bulgarian", status: "translating", text: "partial" },
      { chapterId: chapterId2, key: "Bulgarian", status: "done", text: "t", title: "Има си" },
    ]);

    await translateTitles({ bookId, language: "Bulgarian" });

    expect(mockTranslateTitle).not.toHaveBeenCalled();
  });

  it("continues past per-chapter failures and reports them at the end", async () => {
    const db = getDb();
    const { bookId, chapterId } = await insertFixture(db);
    const chapterId2 = crypto.randomUUID();
    await db.insert(chapters).values({ id: chapterId2, bookId, index: 1, title: "Ch2", rawText: "More text." });
    await db.insert(chapterVariants).values([
      { chapterId, key: "Bulgarian", status: "done", text: "a" },
      { chapterId: chapterId2, key: "Bulgarian", status: "done", text: "b" },
    ]);
    mockTranslateTitle
      .mockRejectedValueOnce(new Error("API down"))
      .mockResolvedValueOnce("Втора глава");

    await expect(translateTitles({ bookId, language: "Bulgarian" })).rejects.toThrow("1 title translation failed");

    const rows = await db.select().from(chapterVariants);
    expect(rows.find((r) => r.chapterId === chapterId2)?.title).toBe("Втора глава");
    expect(rows.find((r) => r.chapterId === chapterId)?.title).toBeNull();
  });
});
