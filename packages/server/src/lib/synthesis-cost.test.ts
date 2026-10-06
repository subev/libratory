import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, chapters, chapterVariants, DEFAULT_PROFILE_ID } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("./elevenlabs.ts", () => ({
  elevenLabsCreditsPerChar: () => 0.5,
  elevenLabsQuota: async () => ({ used: 0, limit: 10_000, remaining: 25, tier: "free" }),
}));

import { estimateSynthesisCost } from "./synthesis-cost.ts";

const ELEVEN = "elevenlabs:JBFqnCBsd6RMkjVDRZzb";
const CARTESIA = "cartesia:fcbecbcc-0cef-4615-8b5a-712fe1b39dd0";

async function bookWith(specs: { text: string; status: "done" | "suspended" | "synthesizing"; selected?: boolean }[]) {
  const db = getDb();
  const [book] = await db.insert(books).values({ title: "A book", kind: "api", profileId: DEFAULT_PROFILE_ID }).returning();
  if (!book) throw new Error("no book");
  const rows = await db
    .insert(chapters)
    .values(specs.map((spec, index) => ({ bookId: book.id, index, title: `Chapter ${index}`, rawText: spec.text, status: spec.status, selected: spec.selected ?? true })))
    .returning({ id: chapters.id });
  return { bookId: book.id, chapterIds: rows.map((r) => r.id) };
}

describe("estimateSynthesisCost", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("prices what Start would send: selected chapters that are not already running", async () => {
    const { bookId } = await bookWith([
      { text: "a".repeat(40), status: "done" },
      { text: "b".repeat(10), status: "suspended" },
      { text: "c".repeat(1000), status: "synthesizing" },
      { text: "d".repeat(1000), status: "suspended", selected: false },
    ]);

    expect(await estimateSynthesisCost({ bookId, voice: ELEVEN, key: null })).toEqual({
      chapters: 2,
      characters: 50,
      provider: "elevenlabs",
      credits: 25,
      remaining: 25,
      partial: false,
    });
    expect(await estimateSynthesisCost({ bookId, voice: CARTESIA, key: null })).toMatchObject({ credits: 50, remaining: null });
  });

  it("prices one chapter of a variant, and marks text still being written", async () => {
    const { bookId, chapterIds } = await bookWith([{ text: "x", status: "done" }, { text: "y", status: "done" }]);
    const [first, second] = chapterIds;
    if (!first || !second) throw new Error("no chapters");
    await getDb().insert(chapterVariants).values([
      { chapterId: first, key: "Bulgarian", text: "п".repeat(30), status: "done" },
      { chapterId: second, key: "Bulgarian", text: "р".repeat(7), status: "translating" },
    ]);

    expect(await estimateSynthesisCost({ bookId, voice: CARTESIA, key: "Bulgarian", chapterId: first })).toMatchObject({ chapters: 1, characters: 30, partial: false });
    expect(await estimateSynthesisCost({ bookId, voice: CARTESIA, key: "Bulgarian" })).toMatchObject({ chapters: 2, characters: 37, partial: true });
  });

  it("says nothing for a voice that does not spend", async () => {
    const { bookId } = await bookWith([{ text: "free", status: "done" }]);
    expect(await estimateSynthesisCost({ bookId, voice: "bg-piper:dimitar", key: null })).toBeNull();
    expect(await estimateSynthesisCost({ bookId, voice: "not a voice", key: null })).toBeNull();
  });
});
