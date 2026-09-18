import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractionProgress } from "./ocr-progress.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function scratch() { const dir = await mkdtemp(path.join(tmpdir(), "ocr-progress-")); dirs.push(dir); return dir; }

it("counts saved pages in incomplete files and ignores their old rejection diagnostics", async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, "llm-pages.json"), JSON.stringify({ complete: false, pages: [{ blocks: [] }, null, null, null] }));
  for (const page of [1, 2, 3]) await writeFile(path.join(dir, `ocr-failure-page-${page}-100.json`), JSON.stringify({
    page, stage: "ordering", message: "Problem", ...(page !== 3 ? { response: "{}" } : {}),
  }));
  expect(await extractionProgress(dir)).toMatchObject({ saved: 1, total: 4, reviewPages: [2], interruptedPages: [3], complete: false, problem: null });
  await writeFile(path.join(dir, "llm-pages.json"), JSON.stringify({ complete: true, pages: [{ blocks: [] }, {}, {}, {}] }));
  expect(await extractionProgress(dir)).toMatchObject({ saved: 4, reviewPages: [], interruptedPages: [], complete: true });
});

it("reports unreadable checkpoints instead of pretending no paid work exists", async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, "llm-pages.json"), "broken");
  expect((await extractionProgress(dir))?.problem).toContain("Nothing has been removed");
});
