import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row, ensureGraphileTables } from "../../test/setup.ts";
import { books, chapters, chapterVariants, bilingualPreparations } from "../schema.ts";
import { textRevision } from "../lib/bilingual-format.ts";
import { writeSyncMap, syncMapPath } from "../lib/sync-map.ts";
import type { PrepareBilingualPayload } from "./prepare-bilingual.ts";

const { embed, requestLinks, queue, installed, encode } = vi.hoisted(() => ({ embed: vi.fn(), requestLinks: vi.fn(), queue: vi.fn(), installed: vi.fn(), encode: vi.fn() }));
vi.mock("../db.ts", async () => { const { getDb } = await import("../../test/setup.ts"); return { get db() { return getDb(); } }; });
vi.mock("../lib/ffmpeg.ts", () => ({ encodeToM4a: encode }));
vi.mock("../lib/embeddings.ts", () => ({ embedTexts: embed }));
vi.mock("../lib/model-bundles.ts", () => ({ bundleInstalled: installed }));
vi.mock("../lib/log.ts", () => ({ appendLog: vi.fn(async () => {}) }));
vi.mock("../lib/llm.ts", () => ({ resolveLlm: async () => ({ def: { key: "test-model" } }), modelKeySchema: z.string(), callSettings: () => ({}) }));
vi.mock("graphile-worker", () => ({ quickAddJob: queue }));
vi.mock("../lib/bilingual-links.ts", async (original) => ({ ...await original<object>(), requestWordLinks: requestLinks }));
import { z } from "zod";
import { booksRouter } from "../routes/books.ts";
import { bilingualRouter } from "../routes/bilingual.ts";
import { prepareBilingual } from "./prepare-bilingual.ts";
import { preparation, failPreparation, isPreparationRunning } from "../lib/bilingual-store.ts";
import { bilingualReferencesForBook, buildBilingualDocument } from "../lib/bilingual-document.ts";
import { buildBilingualExportLayer } from "../lib/bilingual-export.ts";
import { buildP2afLayer, buildTextP2afLayer } from "../lib/p2af.ts";
import { buildCues } from "../lib/reader-doc.ts";
import { buildReadaloudEpub } from "../lib/readaloud-epub.ts";
import { attachTextReaderLayer } from "../lib/epub-reader-layer.ts";
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
  encode.mockReset().mockImplementation(async (input: string, output: string) => writeFile(output, `converted ${await readFile(input, "utf8")}`));
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
  it("keeps default text and synced exports single-language even with prepared links", async () => {
    const audio = path.join(dir, "source.m4a");
    await writeFile(audio, "audio");
    await writeSyncMap(audio, { version: 1, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] });
    await getDb().update(chapters).set({ audioPath: audio, durationMs: 1000 }).where(eq(chapters.id, chapterId));
    await paired();
    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    const text = await buildTextP2afLayer(book, [{ id: chapterId, index: 0, title: "Hello", text: source }]);
    const sync = await buildP2afLayer(book, new Map([[chapterId, { base: "ch000", audioFile: "ch000.m4a" }]]), null);
    expect(text.bilingual).toEqual([]);
    expect(sync?.bilingual).toEqual([]);
    expect(sync?.manifest.chapters[0]?.bilingual).toEqual([]);
  });

  it("queues the explicit language and recordings and refuses incomplete bilingual exports", async () => {
    await paired();
    const booksCaller = booksRouter.createCaller({});
    await booksCaller.exportDocument({ id: bookId, format: "epub-bilingual", language: "German",
      bilingual: { sourceAudio: false, targetAudio: true }, waitForAll: true });
    expect(queue.mock.calls.at(-1)?.[2]).toMatchObject({ bookId, format: "epub-bilingual", language: "German",
      bilingual: { sourceAudio: false, targetAudio: true }, waitForAll: false });
    await expect(booksCaller.exportDocument({ id: bookId, format: "epub-bilingual", language: "French",
      bilingual: { sourceAudio: false, targetAudio: false } })).rejects.toThrow("No finished French translation for 1. Hello — translate them first or leave them out");
    await expect(booksCaller.exportDocument({ id: bookId, format: "epub", language: "German",
      bilingual: { sourceAudio: false, targetAudio: false } })).rejects.toThrow("require Bilingual EPUB");
  });

  it("reports which selected chapters still need pairing, without reading recordings", async () => {
    await getDb().update(chapters).set({ audioPath: dir }).where(eq(chapters.id, chapterId));
    const before = await caller.readiness({ bookId });
    expect(before).toEqual([expect.objectContaining({ key: "German", selected: 1, paired: 0, linked: 0, unpaired: [{ id: chapterId, index: 0, title: "Hello" }], untranslated: [] })]);
    await paired();
    const after = await caller.readiness({ bookId });
    expect(after[0]).toMatchObject({ paired: 1, linked: 0, unpaired: [], unlinked: [{ id: chapterId, index: 0, title: "Hello" }] });
    const booksCaller = booksRouter.createCaller({});
    await getDb().update(chapters).set({ customText: "Changed text." }).where(eq(chapters.id, chapterId));
    await expect(booksCaller.exportDocument({ id: bookId, format: "epub-bilingual", language: "German",
      bilingual: { sourceAudio: false, targetAudio: false } })).rejects.toThrow("Pair current sentences first (Bilingual reading in the German lane): 1. Hello");
  });

  it("carries the translation without its recording, and a chapter without narration, in the page layer", async () => {
    const translated = path.join(dir, "target.m4a");
    await writeFile(translated, "target audio");
    await writeSyncMap(translated, { version: 1, totalMs: 2000, chunks: [{ text: target, startMs: 0, endMs: 2000 }] });
    await getDb().update(chapterVariants).set({ audioPath: translated, audioStatus: "done", audioDurationMs: 2000 }).where(eq(chapterVariants.id, variantId));
    const audio = path.join(dir, "source.m4a");
    await writeFile(audio, "source audio");
    await writeSyncMap(audio, { version: 1, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] });
    await getDb().update(chapters).set({ audioPath: audio, durationMs: 1000 }).where(eq(chapters.id, chapterId));
    await paired();
    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    const silent = await buildP2afLayer(book, new Map([[chapterId, { base: "ch000", audioFile: "ch000.m4a" }]]), null, ["German"], { targetAudio: false });
    expect(silent?.bilingual?.[0]?.doc.source.narration?.totalMs).toBe(1000);
    expect(silent?.bilingual?.[0]?.doc.target.narration).toBeNull();
    expect(silent?.bilingual?.[0]?.audio).toEqual([]);
    // Nothing narrated at all is no layer; with no pages, a chapter the export left out is not in
    // the manifest at all — its text is not in the file either, so it would open on nothing.
    expect(await buildP2afLayer(book, new Map(), null, ["German"])).toBeNull();
    const other = row(await getDb().insert(chapters).values({ bookId, index: 1, title: "Second", rawText: "Second chapter.", status: "done", selected: true, audioPath: audio, durationMs: 1000 }).returning());
    const leftOut = await buildP2afLayer(book, new Map([[other.id, { base: "ch001", audioFile: "ch001.m4a" }]]), null, ["German"]);
    expect(leftOut?.manifest.chapters.map((entry) => entry.id)).toEqual([other.id]);
    const withSecond = await buildP2afLayer(book, new Map([[other.id, { base: "ch001", audioFile: "ch001.m4a" }]]), null, ["German"], { chapters: new Set([chapterId]) });
    const first = withSecond?.manifest.chapters.find((entry) => entry.id === chapterId);
    expect(first?.audio).toBeNull();
    expect(first?.bilingual).toHaveLength(1);
    expect(withSecond?.bilingual?.[0]?.doc.source.narration).toBeNull();
    expect(withSecond?.bilingual?.[0]?.doc.target.narration?.totalMs).toBe(2000);
  });

  it("does not read an unchecked original recording", async () => {
    await getDb().update(chapters).set({ audioPath: dir }).where(eq(chapters.id, chapterId));
    await paired();
    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    const { layer } = await buildBilingualExportLayer(book, "German", { sourceAudio: false, targetAudio: true });
    expect(layer.bilingual?.[0]?.doc.source.narration).toBeNull();
    expect(layer.bilingual?.[0]?.audio).toEqual([]);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("exports chosen bilingual recordings: original %s, translation %s", async (sourceAudio, targetAudio) => {
    const audio = path.join(dir, "source.m4a"), translated = path.join(dir, "target.m4a");
    await writeFile(audio, "source audio"); await writeFile(translated, "target audio");
    await writeSyncMap(audio, { version: 1, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] });
    await writeSyncMap(translated, { version: 1, totalMs: 2000, chunks: [{ text: target, startMs: 0, endMs: 2000 }] });
    await getDb().update(chapters).set({ selected: true, audioPath: audio, durationMs: 1000 }).where(eq(chapters.id, chapterId));
    await getDb().update(chapterVariants).set({ audioPath: translated, audioStatus: "done", audioDurationMs: 2000 }).where(eq(chapterVariants.id, variantId));
    await paired(); await prepareBilingual(await queued("links"));
    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    const { layer } = await buildBilingualExportLayer(book, "German", { sourceAudio, targetAudio });
    expect(layer.bilingual).toHaveLength(1);
    const doc = layer.bilingual?.[0]?.doc;
    expect(!!doc?.source.narration).toBe(sourceAudio);
    expect(!!doc?.target.narration).toBe(targetAudio);
    expect(doc?.pairs[0]?.links).toHaveLength(1);
    expect(layer.bilingual?.[0]?.audio).toHaveLength(Number(sourceAudio) + Number(targetAudio));
    expect(!!layer.manifest.chapters[0]?.audio).toBe(sourceAudio);
    const status = await caller.exportStatus({ bookId, key: "German" });
    expect(status[0]).toMatchObject({ paired: true, source: { available: true }, target: { available: true } });
    await expect(buildBilingualExportLayer(book, "French", { sourceAudio, targetAudio })).rejects.toThrow("Finish");
    await getDb().update(chapters).set({ customText: "Changed text." }).where(eq(chapters.id, chapterId));
    await expect(buildBilingualExportLayer(book, "German", { sourceAudio, targetAudio })).rejects.toThrow("Pair current sentences");
  });

  it("packages selected text and saved word links without requiring recordings or PDF geometry", async () => {
    await getDb().update(books).set({ kind: "pdf", pdfPath: "/missing/source.pdf" }).where(eq(books.id, bookId));
    // Unreadable recordings must not be opened by the text export.
    await getDb().update(chapters).set({ audioPath: dir }).where(eq(chapters.id, chapterId));
    await writeSyncMap(dir, { version: 1, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] });
    try {
      await paired(); await prepareBilingual(await queued("links"));
      const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
      const exported = [{ id: chapterId, index: 0, title: "Hello", text: source }];
      const layer = await buildTextP2afLayer(book, exported, ["German"]);
      expect(layer.manifest.chapters).toHaveLength(1);
      expect(layer.manifest.chapters[0]).toMatchObject({ audio: null, cues: null, text: `text/${chapterId}.json` });
      expect(layer.cues).toEqual([]); expect(layer.sources).toEqual([]);
      const doc = layer.bilingual?.[0]?.doc;
      expect(doc?.source.narration).toBeNull(); expect(doc?.target.narration).toBeNull();
      expect(doc?.pairs[0]?.links).toEqual([{ source: [1], target: [1] }]);
      expect(await buildTextP2afLayer(book, [])).toMatchObject({ manifest: { chapters: [] }, bilingual: [] });
      const stale = await buildTextP2afLayer(book, [{ ...exported[0], id: chapterId, index: 0, title: "Hello", text: "Older exported text." }], ["German"]);
      expect(stale.bilingual).toEqual([]);
      expect(stale.texts?.[0]?.doc.text).toBe("Older exported text.");

      const archive = path.join(dir, "text.epub");
      await mkdir(path.join(dir, "META-INF")); await mkdir(path.join(dir, "EPUB"));
      await writeFile(path.join(dir, "mimetype"), "application/epub+zip");
      await writeFile(path.join(dir, "META-INF/container.xml"), '<container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>');
      await writeFile(path.join(dir, "EPUB/content.opf"), '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>');
      await writeFile(path.join(dir, "EPUB/chapter.xhtml"), '<html xmlns="http://www.w3.org/1999/xhtml"><body>Hello world.</body></html>');
      const exec = promisify(execFile);
      await exec("zip", ["-q", "-0", archive, "mimetype"], { cwd: dir });
      await exec("zip", ["-q", "-r", archive, "META-INF", "EPUB"], { cwd: dir });
      await attachTextReaderLayer(archive, dir, layer);
      const entry = async (name: string) => (await exec("unzip", ["-p", archive, name])).stdout;
      const manifest = JSON.parse(await entry("EPUB/p2af/book.json"));
      expect(manifest.chapters[0].audio).toBeNull();
      expect(JSON.parse(await entry(`EPUB/p2af/${manifest.chapters[0].text}`)).text).toBe(source);
      expect(JSON.parse(await entry(`EPUB/p2af/${manifest.chapters[0].bilingual[0].url}`))).toEqual(doc);
      const opf = await entry("EPUB/content.opf");
      expect(opf).toContain('xmlns="http://www.idpf.org/2007/opf"');
      expect(opf).toContain('<itemref idref="chapter"');
      expect(opf).toContain(`href="p2af/bilingual/${variantId}.json"`);
      expect(opf).toContain(`href="p2af/text/${chapterId}.json"`);
      expect(await entry("EPUB/chapter.xhtml")).toContain("Hello world.");
      expect((await exec("unzip", ["-Z1", archive])).stdout.split("\n")[0]).toBe("mimetype");
      if (!doc) throw new Error("Missing bilingual document");
      doc.source.text = "Hallo world."; doc.source.textRevision = textRevision(doc.source.text);
      await expect(attachTextReaderLayer(archive, dir, layer)).rejects.toThrow("Bilingual source text differs from chapter text");
    } finally { await rm(dir + ".sync.json", { force: true }); }
  });

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
      stagingDir: path.join(dir, "stage"), outputPath, p2af: (exported, cover) => buildP2afLayer(book, exported, cover, ["German"]) });
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
      const layer = await buildP2afLayer(book, new Map([[chapterId, { base: "ch000", audioFile: "ch000.m4a" }]]), null, ["German"]);
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
  it.each([
    ["pairs", "queued"], ["links", "queued"], ["pairs", "running"], ["links", "running"],
  ] as const)("keeps old %s %s work visible, exclusive and cancellable", async (stage, status) => {
    await paired();
    const payload = await queued(stage);
    const field = stage === "pairs" ? "pairJob" : "linkJob";
    const saved = await preparation(variantId), job = saved?.[field];
    if (!job) throw new Error("Missing queued job");
    await getDb().update(bilingualPreparations).set({
      [field]: { ...job, status, updatedAt: new Date(Date.now() - 60 * 60_000).toISOString() },
    }).where(eq(bilingualPreparations.variantId, variantId));
    const selected = { bookId, chapterIds: [chapterId], key: "German" };
    expect(await caller.status({ chapterId, key: "German" })).toMatchObject({ busy: true, [field]: { status } });
    expect((await caller.selection(selected))[0]?.status).toMatchObject({ busy: true, [field]: { status } });
    const calls = queue.mock.calls.length;
    await expect(caller.prepare({ variantId, stage: stage === "pairs" ? "links" : "pairs" })).rejects.toThrow("already running");
    expect(await caller.prepareSelection({ ...selected, stage })).toEqual([]);
    expect(queue).toHaveBeenCalledTimes(calls);
    await caller.cancelSelection(selected);
    expect(await caller.status({ chapterId, key: "German" })).toMatchObject({ busy: false, [field]: { status: "cancelled" } });
    await prepareBilingual(payload);
    expect(requestLinks).not.toHaveBeenCalled();
    expect((await preparation(variantId))?.pairs?.revision).toBe(saved?.pairs?.revision);
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
  it("links the batches after an invalid one instead of stopping there", async () => {
    const longSource = `One ${"one ".repeat(199).trim()}. Two ${"two ".repeat(199).trim()}.`;
    const longTarget = `Eins ${"eins ".repeat(199).trim()}. Zwei ${"zwei ".repeat(199).trim()}.`;
    await getDb().update(chapters).set({ cleanText: longSource }).where(eq(chapters.id, chapterId));
    await getDb().update(chapterVariants).set({ text: longTarget }).where(eq(chapterVariants.id, variantId));
    embed.mockResolvedValueOnce([[1, 0], [0, 1], [1, 0], [0, 1]]);
    await paired();
    requestLinks
      .mockResolvedValueOnce({ record: { ...answer().record, raw: "p1: 99 = 1", error: "Saved 0/1 sentence groups. p1: Token 99 is not in the source sentence. Retry to link the remaining groups." }, links: {} })
      .mockResolvedValueOnce({ record: { ...answer().record, pairIds: ["p2"], raw: "p2: -" }, links: { p2: [] } });
    await expect(prepareBilingual(await queued("links"))).rejects.toThrow("Token 99");
    const saved = await preparation(variantId);
    expect(requestLinks).toHaveBeenCalledTimes(2);
    expect(Object.keys(saved?.links?.byPair ?? {})).toEqual(["p2"]);
    expect(saved?.linkJob?.status).toBe("failed");
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
    const layer = await buildP2afLayer(book, new Map([[chapterId, { base: "ch000", audioFile: "ch000.m4a" }]]), null, ["German"]);
    expect(layer?.bilingual).toHaveLength(1);
    expect(layer?.bilingual?.[0]?.doc.source.narration?.audio).toBe("../audio/ch000.m4a");
    expect(layer?.bilingual?.[0]?.audio[0]?.sourcePath).toBe(translated);
    expect(layer?.manifest.chapters[0]?.bilingual?.[0]?.url).toBe(`bilingual/${variantId}.json`);
  });
});

describe("explicit legacy audio conversion", () => {
  async function recordings() {
    const original = path.join(dir, "source.mp3"), translated = path.join(dir, "target.mp3");
    await writeFile(original, "original MP3"); await writeFile(translated, "translated MP3");
    await writeSyncMap(original, { version: 1, totalMs: 1000, chunks: [{ text: source, startMs: 0, endMs: 1000 }] });
    await writeSyncMap(translated, { version: 1, totalMs: 2000, chunks: [{ text: target, startMs: 0, endMs: 2000 }] });
    await getDb().update(chapters).set({ audioPath: original, durationMs: 1000 }).where(eq(chapters.id, chapterId));
    await getDb().update(chapterVariants).set({ audioPath: translated, audioStatus: "done", audioDurationMs: 2000 }).where(eq(chapterVariants.id, variantId));
    return { original, translated };
  }
  it.each(["suspended", "failed", "pending"] as const)("converts only the translation when the original is %s and has no recording", async (status) => {
    await recordings();
    await getDb().update(chapters).set({ status, audioPath: null, durationMs: null }).where(eq(chapters.id, chapterId));
    await expect(caller.convertAudio({ variantId })).resolves.toEqual({ converted: 1 });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(row(await getDb().select().from(chapters).where(eq(chapters.id, chapterId)))).toMatchObject({ status, audioPath: null });
  });

  it("converts only the original when translation narration is absent", async () => {
    await recordings();
    await getDb().update(chapterVariants).set({ audioStatus: "pending", audioPath: null }).where(eq(chapterVariants.id, variantId));
    await expect(caller.convertAudio({ variantId })).resolves.toEqual({ converted: 1 });
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "target"] as const)("reports and enforces the same blocked reason while the %s MP3 is being narrated", async (side) => {
    await recordings();
    if (side === "source") await getDb().update(chapters).set({ status: "synthesizing" }).where(eq(chapters.id, chapterId));
    else await getDb().update(chapterVariants).set({ audioStatus: "synthesizing" }).where(eq(chapterVariants.id, variantId));
    const status = await caller.status({ chapterId, key: "German" });
    expect(status.convertBlocked).toMatch(/Finish or stop/);
    if (!status.convertBlocked) throw new Error("Expected a blocked reason");
    await expect(caller.convertAudio({ variantId })).rejects.toThrow(status.convertBlocked);
    expect(encode).not.toHaveBeenCalled();
  });

  it("converts both active recordings explicitly while keeping originals, timing and word links", async () => {
    const { original, translated } = await recordings();
    await paired(); await prepareBilingual(await queued("links"));
    const before = await buildBilingualDocument(variantId), prepared = await preparation(variantId);
    expect(await caller.status({ chapterId, key: "German" })).toMatchObject({ legacyAudio: true });
    expect(before?.target.narration?.qualityNotes.join(" ")).toContain("older MP3");
    expect(encode).not.toHaveBeenCalled();
    expect(await caller.convertAudio({ variantId })).toEqual({ converted: 2 });
    expect(await caller.status({ chapterId, key: "German" })).toMatchObject({ legacyAudio: false });
    expect(await readFile(original, "utf8")).toBe("original MP3");
    expect(await readFile(translated, "utf8")).toBe("translated MP3");
    const chapter = row(await getDb().select().from(chapters).where(eq(chapters.id, chapterId)));
    const variant = row(await getDb().select().from(chapterVariants).where(eq(chapterVariants.id, variantId)));
    if (!chapter.audioPath || !variant.audioPath) throw new Error("Missing converted recordings");
    expect(chapter.audioPath).toMatch(/\.m4a$/); expect(variant.audioPath).toMatch(/\.m4a$/);
    expect(await readFile(syncMapPath(chapter.audioPath), "utf8")).toBe(await readFile(syncMapPath(original), "utf8"));
    expect(await readFile(syncMapPath(variant.audioPath), "utf8")).toBe(await readFile(syncMapPath(translated), "utf8"));
    const after = await buildBilingualDocument(variantId);
    expect(after?.source.narration?.revision).not.toBe(before?.source.narration?.revision);
    expect(after?.target.narration?.revision).not.toBe(before?.target.narration?.revision);
    expect(after?.source.narration?.anchors).toEqual(before?.source.narration?.anchors);
    expect(after?.target.narration?.anchors).toEqual(before?.target.narration?.anchors);
    expect((await preparation(variantId))?.links).toEqual(prepared?.links);
    expect(after?.target.narration?.qualityNotes.join(" ")).not.toContain("older MP3");
    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    const layer = await buildP2afLayer(book, new Map([[chapterId, { base: "ch000", audioFile: "ch000.m4a" }]]), null, ["German"]);
    expect(layer?.bilingual?.[0]?.audio[0]).toMatchObject({ sourcePath: variant.audioPath, mediaType: "audio/mp4" });
    expect(await caller.convertAudio({ variantId })).toEqual({ converted: 0 });
    expect(encode).toHaveBeenCalledTimes(2);
  });
  it("keeps both active originals and removes partial copies when conversion fails", async () => {
    const { original, translated } = await recordings();
    encode.mockImplementationOnce(async (_input: string, output: string) => writeFile(output, "converted"))
      .mockRejectedValueOnce(new Error("encoder failed"));
    await expect(caller.convertAudio({ variantId })).rejects.toThrow("encoder failed");
    expect(row(await getDb().select().from(chapters).where(eq(chapters.id, chapterId))).audioPath).toBe(original);
    expect(row(await getDb().select().from(chapterVariants).where(eq(chapterVariants.id, variantId))).audioPath).toBe(translated);
    expect((await readdir(dir)).filter((name) => name.includes(".seek-"))).toEqual([]);
  });
  it.each(["text", "audio", "timing", "narrating"] as const)("rejects a concurrent %s change without publishing converted recordings", async (change) => {
    const { original, translated } = await recordings();
    encode.mockImplementationOnce(async (_input: string, output: string) => {
      await writeFile(output, "converted");
      if (change === "text") await getDb().update(chapters).set({ customText: "Edited." }).where(eq(chapters.id, chapterId));
      if (change === "audio") await writeFile(original, "a different recording");
      if (change === "timing") await writeSyncMap(original, { version: 1, totalMs: 1200, chunks: [{ text: source, startMs: 0, endMs: 1200 }] });
      if (change === "narrating") await getDb().update(chapterVariants).set({ audioStatus: "pending" }).where(eq(chapterVariants.id, variantId));
    });
    await expect(caller.convertAudio({ variantId })).rejects.toThrow("changed during conversion");
    expect(row(await getDb().select().from(chapters).where(eq(chapters.id, chapterId))).audioPath).toBe(original);
    expect(row(await getDb().select().from(chapterVariants).where(eq(chapterVariants.id, variantId))).audioPath).toBe(translated);
    expect((await readdir(dir)).filter((name) => name.includes(".seek-"))).toEqual([]);
  });
});

describe("selected chapter preparation", () => {
  it("skips completed and unavailable chapters, deduplicates the selection, and cancels only selected work", async () => {
    await paired(); await prepareBilingual(await queued("links"));
    const complete = await preparation(variantId);
    const missingChapter = crypto.randomUUID(), missingVariant = crypto.randomUUID(), unavailable = crypto.randomUUID();
    await getDb().insert(chapters).values([
      { id: missingChapter, bookId, index: 1, title: "Next", rawText: source },
      { id: unavailable, bookId, index: 2, title: "No translation", rawText: source },
    ]);
    await getDb().insert(chapterVariants).values({ id: missingVariant, chapterId: missingChapter, key: "German", text: target, status: "done" });
    const input = { bookId, key: "German", chapterIds: [chapterId, missingChapter, unavailable, missingChapter] };
    const statuses = await caller.selection(input);
    expect(statuses).toHaveLength(3);
    expect(statuses[0]?.status).toMatchObject({ current: true, linked: 1, batches: 0 });
    expect(statuses[1]).toMatchObject({ available: true, status: { current: false } });
    expect(statuses[2]).toMatchObject({ available: false, status: null });
    queue.mockClear();
    expect(await caller.prepareSelection({ ...input, stage: "pairs" })).toEqual([{ chapterId: missingChapter, queued: true, error: null }]);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0]?.[2]).toMatchObject({ variantId: missingVariant, stage: "pairs" });
    expect(queue.mock.calls[0]?.[3]).toMatchObject({ maxAttempts: 1 });
    expect(await caller.prepareSelection({ ...input, stage: "pairs" })).toEqual([]);
    await caller.cancelSelection(input);
    expect((await preparation(missingVariant))?.pairJob?.status).toBe("cancelled");
    expect(await preparation(variantId)).toEqual(complete);
  });

  it("rejects a foreign chapter before queueing, and exposes queue failure for an explicit retry", async () => {
    await paired(); queue.mockClear();
    await expect(caller.prepareSelection({ bookId: crypto.randomUUID(), chapterIds: [chapterId], key: "German", stage: "links", model: "test-model" })).rejects.toThrow("another book");
    expect(queue).not.toHaveBeenCalled();
    const input = { bookId, chapterIds: [chapterId], key: "German", stage: "links" as const, model: "test-model" };
    const before = await caller.status({ chapterId, key: "German" });
    const selected = await caller.selection(input);
    expect(selected[0]?.status?.estimatedInputTokens).toBe(before.estimatedInputTokens);
    expect(before.estimatedInputTokens).toBeGreaterThan(0);
    queue.mockRejectedValueOnce(new Error("Queue unavailable"));
    expect(await caller.prepareSelection(input)).toEqual([{ chapterId, queued: false, error: "Queue unavailable" }]);
    expect((await preparation(variantId))?.linkJob?.status).toBe("failed");
    expect((await caller.selection(input))[0]?.status?.current).toBe(true);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(await caller.prepareSelection(input)).toEqual([{ chapterId, queued: true, error: null }]);
    expect(queue).toHaveBeenCalledTimes(2);
    expect((await preparation(variantId))?.linkJob?.status).toBe("queued");
  });

  it("rechecks completed work under the lock before bulk pairing can replace it", async () => {
    await paired();
    const saved = await preparation(variantId);
    await getDb().update(bilingualPreparations).set({ pairs: null }).where(eq(bilingualPreparations.variantId, variantId));
    installed.mockImplementationOnce(async () => {
      await getDb().update(bilingualPreparations).set({ pairs: saved?.pairs }).where(eq(bilingualPreparations.variantId, variantId));
      return true;
    });
    queue.mockClear();
    expect(await caller.prepareSelection({ bookId, chapterIds: [chapterId], key: "German", stage: "pairs" })).toEqual([{ chapterId, queued: false, error: null }]);
    expect(queue).not.toHaveBeenCalled();
    expect((await preparation(variantId))?.pairs).toEqual(saved?.pairs);
  });
});
