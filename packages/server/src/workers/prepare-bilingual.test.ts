import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row, ensureGraphileTables } from "../../test/setup.ts";
import { books, chapters, chapterVariants, bilingualPreparations } from "../schema.ts";
import { textRevision } from "../lib/bilingual-format.ts";
import { writeSyncMap } from "../lib/sync-map.ts";
import type { PrepareBilingualPayload } from "./prepare-bilingual.ts";

const { embed, requestLinks, queue, installed } = vi.hoisted(() => ({ embed: vi.fn(), requestLinks: vi.fn(), queue: vi.fn(), installed: vi.fn() }));
vi.mock("../db.ts", async () => { const { getDb } = await import("../../test/setup.ts"); return { get db() { return getDb(); } }; });
vi.mock("../lib/embeddings.ts", () => ({ embedTexts: embed }));
vi.mock("../lib/model-bundles.ts", () => ({ bundleInstalled: installed }));
vi.mock("../lib/log.ts", () => ({ appendLog: vi.fn(async () => {}) }));
vi.mock("../lib/llm.ts", () => ({ resolveLlm: async () => ({ def: { key: "test-model" } }), modelKeySchema: z.string(), callSettings: () => ({}) }));
vi.mock("graphile-worker", () => ({ quickAddJob: queue }));
vi.mock("../lib/bilingual-links.ts", async (original) => ({ ...await original<object>(), requestWordLinks: requestLinks }));
import { z } from "zod";
import { bilingualRouter } from "../routes/bilingual.ts";
import { prepareBilingual } from "./prepare-bilingual.ts";
import { preparation, failPreparation, isPreparationRunning } from "../lib/bilingual-store.ts";
import { bilingualReferencesForBook, buildBilingualDocument } from "../lib/bilingual-document.ts";
import { buildP2afLayer } from "../lib/p2af.ts";
import { buildCues } from "../lib/reader-doc.ts";
import { buildReadaloudEpub } from "../lib/readaloud-epub.ts";
import { bookTmpDir } from "../lib/paths.ts";
import * as bilingualDocuments from "../lib/bilingual-document.ts";
import { appendLog } from "../lib/log.ts";
import * as segmentation from "../lib/bilingual-segment.ts";
import { sweepStrandedWork } from "./sweep.ts";

const caller = bilingualRouter.createCaller({});
const source = "Hello world.", target = "Hallo Welt.";
let bookId: string, chapterId: string, variantId: string, dir: string;

async function queued(stage: "pairs" | "links"): Promise<PrepareBilingualPayload> {
  await caller.prepare({ variantId, stage });
  return queue.mock.calls.at(-1)?.[2] as PrepareBilingualPayload;
}
async function paired() { await prepareBilingual(await queued("pairs")); }
const answer = () => ({ record: { pairIds: ["p1"], model: "test-model", raw: "p1: 1 = 1", error: null, inputTokens: 10, outputTokens: 5 }, links: { p1: [{ source: [1], target: [1] }] } });

beforeEach(async () => {
  await resetDb(getDb());
  vi.clearAllMocks();
  embed.mockReset().mockResolvedValue([[1, 0], [1, 0]]);
  requestLinks.mockReset().mockImplementation(async () => answer());
  installed.mockResolvedValue(true);
  queue.mockReset().mockResolvedValue(undefined);
  dir = await mkdtemp(path.join(tmpdir(), "bilingual-job-"));
  bookId = crypto.randomUUID(); chapterId = crypto.randomUUID(); variantId = crypto.randomUUID();
  await getDb().insert(books).values({ id: bookId, title: "Bilingual", kind: "api", language: "English" });
  await getDb().insert(chapters).values({ id: chapterId, bookId, index: 0, title: "Hello", rawText: source, cleanText: source, status: "done" });
  await getDb().insert(chapterVariants).values({ id: variantId, chapterId, key: "German", kind: "translation", text: target, status: "done" });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(bookTmpDir(bookId), { recursive: true, force: true });
});

describe("bilingual jobs and publication", () => {
  it("fails before publishing when generated tokens violate the document format", async () => {
    const tokenizer = vi.spyOn(segmentation, "tokenize").mockReturnValue([{ id: 1, start: 0, end: 1000 }]);
    try {
      await expect(paired()).rejects.toThrow("token range");
      const saved = await preparation(variantId);
      expect(saved?.pairs).toBeNull();
      expect(saved?.pairJob?.status).toBe("failed");
    } finally { tokenizer.mockRestore(); }
  });
  it("does not invent English when a book has no language set", async () => {
    await getDb().update(books).set({ language: null }).where(eq(books.id, bookId));
    await paired();
    expect((await preparation(variantId))?.pairs?.source.language).toBe("und");
  });
  it("gives a translation named Hebrew its actual language tag", async () => {
    await getDb().update(chapterVariants).set({ key: "Hebrew", text: "שלום עולם." }).where(eq(chapterVariants.id, variantId));
    await paired();
    expect((await preparation(variantId))?.pairs?.target.language).toBe("he");
  });
  it("keeps a voice with an unlocatable chunk but leaves that passage untimed", async () => {
    const text = "Hello world. Missing text. Good bye.";
    await getDb().update(chapters).set({ cleanText: text }).where(eq(chapters.id, chapterId));
    await getDb().update(chapterVariants).set({ text: "Hallo Welt. Fehlender Text. Auf Wiedersehen." }).where(eq(chapterVariants.id, variantId));
    embed.mockResolvedValueOnce([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    const audioPath = path.join(dir, "source.m4a");
    await writeFile(audioPath, "recording");
    await writeSyncMap(audioPath, { version: 1, totalMs: 3000, chunks: [
      { text: "Hello world.", startMs: 0, endMs: 1000 },
      { text: "Different recorded text.", startMs: 1000, endMs: 2000 },
      { text: "Good bye.", startMs: 2000, endMs: 3000 },
    ] });
    await getDb().update(chapters).set({ audioPath }).where(eq(chapters.id, chapterId));
    await paired();
    const doc = await buildBilingualDocument(variantId);
    expect(doc?.source.narration?.anchors.map((a) => [a.start.ms, a.end.ms])).toEqual([[0, 1000], [null, null], [2000, 3000]]);
    expect(doc?.source.narration?.qualityNotes).toContain("Some recorded passages could not be matched to the text; timing is unavailable there.");
  });
  it.each([true, false])("exports a PDF chapter through real cue construction with unstructured text (edited=%s)", async (edited) => {
    await getDb().update(books).set({ kind: "pdf", filename: "scan.pdf", pdfPath: path.resolve("test/fixtures/scanned-page.pdf") }).where(eq(books.id, bookId));
    await mkdir(bookTmpDir(bookId), { recursive: true });
    await writeFile(path.join(bookTmpDir(bookId), "geometry.json"), JSON.stringify({ version: 4, pages: [{ i: 0, w: 595, h: 842, rot: 0, cropOffset: [0, 0], lines: [] }] }));
    const audioPath = path.join(dir, "source.m4a");
    const sync = { version: 1 as const, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] };
    await writeFile(audioPath, "source recording"); await writeSyncMap(audioPath, sync);
    await getDb().update(chapters).set({ customText: edited ? source : null, sourceBlocks: [{ type: "Text", text: "Old extraction.", included: true, page: 1 }], audioPath }).where(eq(chapters.id, chapterId));
    await paired();
    const chapter = row(await getDb().select().from(chapters).where(eq(chapters.id, chapterId)));
    const cues = await buildCues(chapter);
    expect(cues?.text?.text).toBe(source);
    expect(cues?.text?.blocks).toBeUndefined();
    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    const outputPath = path.join(dir, "book.epub");
    await buildReadaloudEpub({ title: book.title, language: book.language, chapters: [{ id: chapterId, index: 0, title: chapter.title, audioPath, sync }],
      stagingDir: path.join(dir, "stage"), outputPath, p2af: (exported, cover) => buildP2afLayer(book, exported, cover) });
    const { stdout } = await promisify(execFile)("unzip", ["-p", outputPath, `OEBPS/p2af/bilingual/${variantId}.json`]);
    expect(JSON.parse(stdout).source.text).toBe(source);
  });
  it("logs and omits a concurrently changed optional attachment without failing primary export", async () => {
    const audioPath = path.join(dir, "source.m4a");
    await writeSyncMap(audioPath, { version: 1, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] });
    await getDb().update(chapters).set({ audioPath }).where(eq(chapters.id, chapterId));
    await paired();
    const build = vi.spyOn(bilingualDocuments, "buildBilingualDocument").mockResolvedValueOnce(null);
    try {
      const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
      const layer = await buildP2afLayer(book, new Map([[chapterId, { base: "ch000", audioFile: "ch000.m4a" }]]), null);
      expect(layer?.cues).toHaveLength(1);
      expect(layer?.bilingual).toEqual([]);
      expect(layer?.manifest.chapters[0]?.bilingual).toEqual([]);
      expect(appendLog).toHaveBeenCalledWith(bookId, expect.stringContaining("was omitted"));
    } finally { build.mockRestore(); }
  });
  it("prepares and serves existing texts without requiring narration or word links", async () => {
    await paired();
    const saved = await preparation(variantId);
    expect(saved?.pairJob?.status).toBe("done");
    expect(saved?.pairs?.source.textRevision).toBe(textRevision(source));
    expect(await bilingualReferencesForBook(bookId)).toHaveLength(1);
    const doc = await buildBilingualDocument(variantId);
    expect(doc?.source.narration).toBeNull();
    expect(doc?.pairs[0]?.linksStatus).toBe("unavailable");
    expect(queue).toHaveBeenCalledWith(expect.anything(), "alignBilingual", expect.anything(), expect.objectContaining({ maxAttempts: 1 }));
    expect(requestLinks).not.toHaveBeenCalled();
  });
  it("refuses a missing optional model without downloading or queueing", async () => {
    installed.mockResolvedValue(false);
    await expect(queued("pairs")).rejects.toThrow("optional search model");
    expect(queue).not.toHaveBeenCalled();
  });
  it("rejects text changed while queued and marks context failures as failed", async () => {
    const payload = await queued("pairs");
    await getDb().update(chapters).set({ customText: "Changed." }).where(eq(chapters.id, chapterId));
    await expect(prepareBilingual(payload)).rejects.toThrow("Text changed");
    expect((await preparation(variantId))?.pairJob?.status).toBe("failed");
    const next = await queued("pairs");
    await getDb().update(chapterVariants).set({ status: "failed" }).where(eq(chapterVariants.id, variantId));
    await expect(prepareBilingual(next)).rejects.toThrow("completed translation");
    expect((await preparation(variantId))?.pairJob?.status).toBe("failed");
  });
  it("never publishes pairs when text changes during embedding", async () => {
    embed.mockImplementationOnce(async () => {
      await getDb().update(chapterVariants).set({ text: "Anderer Text." }).where(eq(chapterVariants.id, variantId));
      return [[1, 0], [1, 0]];
    });
    await paired();
    const saved = await preparation(variantId);
    expect(saved?.pairs).toBeNull();
    expect(saved?.pairJob).toMatchObject({ status: "failed", error: expect.stringContaining("changed") });
  });
  it("checks active ownership without reviving a cancelled run", async () => {
    const payload = await queued("pairs");
    expect(await isPreparationRunning(variantId, "pairs", payload.runId)).toBe(false);
    embed.mockImplementationOnce(async () => {
      expect(await isPreparationRunning(variantId, "pairs", payload.runId)).toBe(true);
      expect(await isPreparationRunning(variantId, "pairs", "another-run")).toBe(false);
      expect(await isPreparationRunning(variantId, "links", payload.runId)).toBe(false);
      await caller.cancel({ variantId, stage: "pairs" });
      expect(await isPreparationRunning(variantId, "pairs", payload.runId)).toBe(false);
      return [[1, 0], [1, 0]];
    });
    await prepareBilingual(payload);
    expect((await preparation(variantId))?.pairs).toBeNull();
    expect((await preparation(variantId))?.pairJob?.status).toBe("cancelled");
  });
  it("fences a cancelled run from a newer run, including its failure handler", async () => {
    const old = await queued("pairs");
    await caller.cancel({ variantId, stage: "pairs" });
    const next = await queued("pairs");
    await prepareBilingual(old);
    await failPreparation(variantId, "pairs", old.runId, "old failure");
    expect((await preparation(variantId))?.pairJob).toMatchObject({ runId: next.runId, status: "queued" });
    await prepareBilingual(next);
    expect(embed).toHaveBeenCalledTimes(1);
  });
  it("discards an in-flight word batch after cancellation and retries only explicitly", async () => {
    await paired();
    requestLinks.mockImplementationOnce(async () => {
      await caller.cancel({ variantId, stage: "links" });
      return answer();
    });
    await prepareBilingual(await queued("links"));
    expect((await preparation(variantId))?.linkJob?.status).toBe("cancelled");
    expect((await preparation(variantId))?.links).toBeNull();
    await prepareBilingual(await queued("links"));
    expect((await buildBilingualDocument(variantId))?.pairs[0]?.links).toHaveLength(1);
    expect(requestLinks).toHaveBeenCalledTimes(2);
    await prepareBilingual(await queued("links"));
    expect(requestLinks).toHaveBeenCalledTimes(2);
  });
  it("retains a completed batch when a later call fails and resumes only the missing batch", async () => {
    const longSource = `One ${"one ".repeat(199).trim()}. Two ${"two ".repeat(199).trim()}.`;
    const longTarget = `Eins ${"eins ".repeat(199).trim()}. Zwei ${"zwei ".repeat(199).trim()}.`;
    await getDb().update(chapters).set({ cleanText: longSource }).where(eq(chapters.id, chapterId));
    await getDb().update(chapterVariants).set({ text: longTarget }).where(eq(chapterVariants.id, variantId));
    embed.mockResolvedValueOnce([[1, 0], [0, 1], [1, 0], [0, 1]]);
    await paired();
    expect((await caller.status({ chapterId, key: "German" })).batches).toBe(2);
    requestLinks.mockResolvedValueOnce(answer()).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(prepareBilingual(await queued("links"))).rejects.toThrow("provider unavailable");
    expect((await preparation(variantId))?.links?.byPair.p1).toHaveLength(1);
    requestLinks.mockImplementationOnce(async (_artifact, pairs) => {
      expect(pairs.map((p: { id: string }) => p.id)).toEqual(["p2"]);
      return { record: { ...answer().record, pairIds: ["p2"], raw: "p2: -" }, links: { p2: [] } };
    });
    await prepareBilingual(await queued("links"));
    expect(Object.keys((await preparation(variantId))?.links?.byPair ?? {})).toEqual(["p1", "p2"]);
    expect(requestLinks).toHaveBeenCalledTimes(3);
  });
  it("keeps invalid raw answers for diagnosis, fails once and preserves prior batches", async () => {
    await paired();
    const saved = await preparation(variantId);
    if (!saved?.pairs) throw new Error("no pairs");
    await getDb().update(bilingualPreparations).set({ links: { pairRevision: saved.pairs.revision, promptVersion: "token-ids/1", byPair: {}, batches: [{ ...answer().record, pairIds: [], raw: "previous batch" }] } }).where(eq(bilingualPreparations.variantId, variantId));
    requestLinks.mockResolvedValueOnce({ record: { ...answer().record, raw: "broken", error: "Invalid batch" }, links: null });
    await expect(prepareBilingual(await queued("links"))).rejects.toThrow("Invalid batch");
    const result = await preparation(variantId);
    expect(result?.links?.batches.map((b) => b.raw)).toEqual(["previous batch", "broken"]);
    expect(result?.links?.byPair).toEqual({});
    expect(result?.linkJob?.status).toBe("failed");
    expect(requestLinks).toHaveBeenCalledTimes(1);
  });
  it("saves valid groups from a partially invalid batch before failing, then resumes the rejected group", async () => {
    await getDb().update(chapters).set({ cleanText: "Hello world. Good bye." }).where(eq(chapters.id, chapterId));
    await getDb().update(chapterVariants).set({ text: "Hallo Welt. Auf Wiedersehen." }).where(eq(chapterVariants.id, variantId));
    embed.mockResolvedValueOnce([[1, 0], [0, 1], [1, 0], [0, 1]]);
    await paired();
    requestLinks.mockResolvedValueOnce({ ...answer(), record: { ...answer().record, pairIds: ["p1", "p2"], error: "Invalid p2; saved p1" } });
    await expect(prepareBilingual(await queued("links"))).rejects.toThrow("Invalid p2");
    const saved = await preparation(variantId);
    expect(saved?.linkJob?.status).toBe("failed");
    expect(Object.keys(saved?.links?.byPair ?? {})).toEqual(["p1"]);
    requestLinks.mockImplementationOnce(async (_artifact, pairs) => {
      expect(pairs.map((p: { id: string }) => p.id)).toEqual(["p2"]);
      return { record: { ...answer().record, pairIds: ["p2"], raw: "p2: -" }, links: { p2: [] } };
    });
    await prepareBilingual(await queued("links"));
    expect((await preparation(variantId))?.linkJob?.status).toBe("done");
    expect(requestLinks).toHaveBeenCalledTimes(2);
  });
  it("removes stale references after edits without deleting saved diagnostics", async () => {
    await paired();
    await getDb().update(chapters).set({ customText: "Changed." }).where(eq(chapters.id, chapterId));
    expect(await bilingualReferencesForBook(bookId)).toEqual([]);
    expect(await buildBilingualDocument(variantId)).toBeNull();
    expect((await preparation(variantId))?.pairs).not.toBeNull();
  });
  it("marks enqueue failures and interrupted runs failed, preserving pairs", async () => {
    await paired();
    queue.mockRejectedValueOnce(new Error("queue offline"));
    await expect(queued("links")).rejects.toThrow("queue offline");
    expect((await preparation(variantId))?.linkJob?.status).toBe("failed");
    await queued("links");
    await ensureGraphileTables(getDb());
    await getDb().execute(sql`UPDATE chapters SET status = 'done'`);
    await sweepStrandedWork();
    expect((await preparation(variantId))?.linkJob?.status).toBe("failed");
    expect((await preparation(variantId))?.pairs).not.toBeNull();
  });
  it("derives fresh timing after audio replacement and attaches both lanes to normal export", async () => {
    const audio = path.join(dir, "source.m4a"), translated = path.join(dir, "target.m4a");
    await writeFile(audio, "source audio"); await writeFile(translated, "target audio");
    await writeSyncMap(audio, { version: 1, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] });
    await writeSyncMap(translated, { version: 1, totalMs: 2000, chunks: [{ text: target, startMs: 0, endMs: 2000 }] });
    await getDb().update(chapters).set({ audioPath: audio, durationMs: 1000 }).where(eq(chapters.id, chapterId));
    await getDb().update(chapterVariants).set({ audioPath: translated, audioStatus: "done", audioDurationMs: 2000 }).where(eq(chapterVariants.id, variantId));
    await paired();
    const before = await buildBilingualDocument(variantId);
    const revision = (await preparation(variantId))?.pairs?.revision;
    await writeFile(translated, "replacement audio");
    await writeSyncMap(translated, { version: 1, totalMs: 3000, chunks: [{ text: target, startMs: 0, endMs: 3000 }] });
    const after = await buildBilingualDocument(variantId);
    expect(after?.target.narration?.revision).not.toBe(before?.target.narration?.revision);
    expect(after?.target.narration?.totalMs).toBe(3000);
    expect((await preparation(variantId))?.pairs?.revision).toBe(revision);
    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    const layer = await buildP2afLayer(book, new Map([[chapterId, { base: "ch000", audioFile: "ch000.m4a" }]]), null);
    expect(layer?.bilingual).toHaveLength(1);
    expect(layer?.bilingual?.[0]?.doc.source.narration?.audio).toBe("../audio/ch000.m4a");
    expect(layer?.bilingual?.[0]?.audio[0]?.sourcePath).toBe(translated);
    expect(layer?.manifest.chapters[0]?.bilingual?.[0]?.url).toBe(`bilingual/${variantId}.json`);
  });
});
