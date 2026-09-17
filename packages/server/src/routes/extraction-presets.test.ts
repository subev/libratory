import { beforeEach, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books } from "../schema.ts";
import { eq } from "drizzle-orm";
vi.mock("../db.ts", async () => { const { getDb } = await import("../../test/setup.ts"); return { get db() { return getDb(); } }; });
import { extractionPresetsRouter } from "./extraction-presets.ts";
import { STANDARD_EXTRACTION } from "../lib/extraction-presets.ts";
const caller = extractionPresetsRouter.createCaller({});
beforeEach(() => resetDb(getDb()));
it("saves reusable presets without changing a book's selected snapshot", async () => {
  const settings = { ...STANDARD_EXTRACTION, prompt: "Keep dialect spelling.", lineOrdering: true, orderingPrompt: "Verse before notes." };
  const saved = await caller.save({ name: "Dialect", settings });
  if (!saved) throw new Error("Preset missing");
  const book = row(await getDb().insert(books).values({ title: "Snapshot", extractionSettings: settings }).returning());
  expect((await caller.list()).find((p) => p.id === saved.id)?.settings).toEqual(settings);
  await caller.remove({ id: saved.id });
  expect((await caller.list()).map((p) => p.id)).toEqual(["standard", "columns-poetry"]);
  expect(row(await getDb().select().from(books).where(eq(books.id, book.id))).extractionSettings).toEqual(settings);
});
it("rejects empty instructions and built-in deletion", async () => {
  await expect(caller.save({ name: "Empty", settings: { ...STANDARD_EXTRACTION, prompt: " " } })).rejects.toThrow();
  await expect(caller.remove({ id: "standard" })).rejects.toThrow();
});
