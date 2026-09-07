import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExtractAbortedError } from "./marker.ts";
import { runTesseractOcr } from "./ocr-tesseract.ts";
import { extractPdfRawText, pdfHasTextLayer } from "./pdf-raw-text.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");

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

    // The rendered pages are the bulk of a 300-page run and are worth nothing once read
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
