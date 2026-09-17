import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importSuryaRecovery, openLineCache, suryaCachePath } from "./ocr-line-cache.ts";
import { readSuryaLines } from "./ocr-line-order.ts";
import { runSurya, type SuryaRun } from "./ocr-surya.ts";

vi.mock("./model-bundles.ts", () => ({ bundleInstalled: async () => true }));
vi.mock("./ocr-surya.ts", () => ({ runSurya: vi.fn(), SURYA_BUNDLE: "extraction", suryaDevice: async () => "cpu" }));
const dirs: string[] = [];
afterEach(async () => { vi.resetAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function input() {
  const dir = await mkdtemp(path.join(tmpdir(), "line-cache-")); dirs.push(dir);
  const pdfPath = path.join(dir, "book.pdf"); await writeFile(pdfPath, "original PDF");
  return { pdfPath, outDir: path.join(dir, "out"), workDir: path.join(dir, "work"), language: null, log: async () => {} };
}
const page = { page: 1, size: [100, 200] as [number, number], lines: [{ id: 1, text: "Words", box: [10, 20, 100, 40] as [number, number, number, number] }] };

it("keeps completed pages outside temporary output and rejects stale source content", async () => {
  const file = await input();
  const cache = await openLineCache(file.pdfPath, 2);
  await cache.save(page);
  expect((await openLineCache(file.pdfPath, 2)).pages.get(1)).toEqual(page);
  await rm(file.outDir, { recursive: true, force: true });
  expect((await openLineCache(file.pdfPath, 2)).pages.size).toBe(1);
  await writeFile(file.pdfPath, "a changed PDF");
  expect((await openLineCache(file.pdfPath, 2)).pages.size).toBe(0);
});

it("imports a verified recovery and refuses an altered PDF", async () => {
  const file = await input(); const source = await stat(file.pdfPath);
  const recovery = path.join(path.dirname(file.pdfPath), "recovery.json");
  await writeFile(recovery, JSON.stringify({ version: 1, coordinateSpace: "normalized-1000", pdfPath: file.pdfPath,
    source: { size: source.size, mtimeMs: source.mtimeMs }, completedThrough: 1, pages: [page] }));
  expect(await importSuryaRecovery(recovery, file.pdfPath, 2)).toBe(1);
  await writeFile(file.pdfPath, "different PDF contents");
  await expect(importSuryaRecovery(recovery, file.pdfPath, 2)).rejects.toThrow("changed PDF");
});

function emitPage(run: SuryaRun, page: number, complete: boolean) {
  run.onEvent?.({ event: "page", page, width: 100, height: 200 });
  run.onEvent?.({ event: "detected", page, lines: 1 });
  run.onEvent?.({ event: "line", page, index: 1, total: 1, text: "Words", bbox: [1, 4, 10, 8] });
  if (complete) run.onEvent?.({ event: "page-done", page, elapsedMs: 1 });
}

it("checkpoints completed pages on failure and recognizes only unfinished pages on resume", async () => {
  const file = await input();
  vi.mocked(runSurya).mockImplementationOnce(async (_args, run) => {
    emitPage(run, 1, true); emitPage(run, 2, false); throw new Error("Stopped");
  });
  await expect(readSuryaLines(file, { pageCount: 2, neededPages: [1, 2], onPage: () => {} })).rejects.toThrow("Stopped");
  const saved = JSON.parse(await readFile(suryaCachePath(file.pdfPath), "utf8"));
  expect(saved.pages).toEqual([page]);
  const ready: number[] = [];
  vi.mocked(runSurya).mockImplementationOnce(async (args, run) => {
    expect(args.slice(-2)).toEqual(["--pages", "2"]);
    expect(ready).toEqual([1]);
    emitPage(run, 2, true);
  });
  const pages = await readSuryaLines(file, { pageCount: 2, neededPages: [1, 2], onPage: (page) => { ready.push(page); } });
  expect([...pages.keys()]).toEqual([1, 2]);
  expect((await openLineCache(file.pdfPath, 2)).pages.size).toBe(2);
});

it("never checkpoints a page with missing recognition events", async () => {
  const file = await input();
  vi.mocked(runSurya).mockImplementationOnce(async (_args, run) => {
    run.onEvent?.({ event: "page", page: 1, width: 100, height: 200 });
    run.onEvent?.({ event: "detected", page: 1, lines: 2 });
    run.onEvent?.({ event: "page-done", page: 1, elapsedMs: 1 });
  });
  await expect(readSuryaLines(file, { pageCount: 1, neededPages: [1], onPage: () => {} })).rejects.toThrow("Incomplete Surya");
  expect((await openLineCache(file.pdfPath, 1)).pages.size).toBe(0);
});
