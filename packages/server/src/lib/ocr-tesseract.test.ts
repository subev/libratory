import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// The machine running the suite may have downloaded more packs; the missing-pack case must not
// start passing or failing on what is in its tessdata directory.
vi.mock("./tessdata.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tessdata.ts")>()),
  installedPacks: vi.fn(async () => ["eng", "osd"]),
}));

import { ExtractAbortedError } from "./marker.ts";
import { parseTsv, pdfPageSizes, runTesseractOcr } from "./ocr-tesseract.ts";
import { extractPdfRawText, pdfHasTextLayer } from "./pdf-raw-text.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");
const execFileAsync = promisify(execFile);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function scratch(): Promise<{ outPdfPath: string; workDir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ocr-tesseract-"));
  dirs.push(dir);
  return { outPdfPath: path.join(dir, "page.ocr.pdf"), workDir: path.join(dir, "work") };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("runTesseractOcr", () => {
  it("turns a page of images into a searchable PDF and reports how well it read", async () => {
    const { outPdfPath, workDir } = await scratch();

    const stats = await runTesseractOcr({
      pdfPath: FIXTURE,
      outPdfPath,
      language: "en",
      workDir,
      log: async () => {},
    });

    expect(await pdfHasTextLayer(FIXTURE)).toBe(false);
    expect(await pdfHasTextLayer(outPdfPath)).toBe(true);
    expect(await extractPdfRawText(outPdfPath)).toContain("Voyage");

    expect(stats.confidence).toBeGreaterThan(0.5);
    expect(stats.confidence).toBeLessThanOrEqual(1);
    expect(stats.lowConfidenceFraction).toBeGreaterThanOrEqual(0);
    expect(stats.lowConfidenceFraction).toBeLessThan(0.5);

    expect(await exists(workDir)).toBe(false);
  }, 60_000);

  it("leaves nothing behind when the run is cancelled", async () => {
    const { outPdfPath, workDir } = await scratch();
    const controller = new AbortController();

    await expect(
      runTesseractOcr({
        pdfPath: FIXTURE,
        outPdfPath,
        language: "en",
        workDir,
        // The first line is the render starting, so this stops a run that is genuinely under way
        log: async () => controller.abort(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ExtractAbortedError);

    expect(await exists(outPdfPath)).toBe(false);
    expect(await exists(workDir)).toBe(false);
  }, 60_000);

  it("names the missing pack rather than reading the page in the wrong language", async () => {
    const { outPdfPath, workDir } = await scratch();

    await expect(
      runTesseractOcr({ pdfPath: FIXTURE, outPdfPath, language: "bg", workDir, log: async () => {} }),
    ).rejects.toThrow(/Bulgarian language pack \(bul\.traineddata\)/);
  });
});

describe("parseTsv", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "1\t1\t0\t0\t0\t0\t0\t0\t1133\t1600\t-1\t",
    "4\t1\t1\t1\t1\t0\t139\t136\t528\t36\t-1\t",
    "5\t1\t1\t1\t1\t1\t139\t136\t139\t36\t96.7\tChapter",
    "5\t1\t1\t1\t1\t2\t296\t137\t24\t27\t54.5\t1.",
    "5\t1\t1\t1\t2\t1\t139\t180\t60\t30\t91.0\tThe",
    "5\t1\t2\t1\t1\t1\t139\t260\t80\t30\t88.0\tship",
    "5\t1\t2\t1\t1\t2\t230\t260\t10\t30\t95.0\t ",
  ].join("\n");

  it("reads word boxes, numbers the printed lines, and rebuilds the text tesseract would print", () => {
    const page = parseTsv(tsv);
    expect(page.width).toBe(1133);
    expect(page.height).toBe(1600);
    expect(page.words).toEqual([
      { text: "Chapter", box: [139, 136, 278, 172], conf: 96.7, line: 0 },
      { text: "1.", box: [296, 137, 320, 164], conf: 54.5, line: 0 },
      { text: "The", box: [139, 180, 199, 210], conf: 91, line: 1 },
      { text: "ship", box: [139, 260, 219, 290], conf: 88, line: 2 },
    ]);
    expect(page.text).toBe("Chapter 1.\nThe\n\nship\n");
  });

  it("gives an empty page for a TSV with no words", () => {
    expect(parseTsv("level\tpage_num\n1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t")).toEqual({ words: [], text: "", width: 800, height: 600 });
  });
});

describe("pdfPageSizes", () => {
  it("reports each page as displayed, sides swapped when the page is rotated", async () => {
    expect(await pdfPageSizes(FIXTURE)).toEqual([{ width: 1241, height: 1754 }]);
    const dir = await mkdtemp(path.join(tmpdir(), "rot-"));
    dirs.push(dir);
    await execFileAsync("qpdf", ["--rotate=+90", FIXTURE, path.join(dir, "r90.pdf")]);
    expect(await pdfPageSizes(path.join(dir, "r90.pdf"))).toEqual([{ width: 1754, height: 1241, rotation: 90 }]);
  });
});
