import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { extractPdfRawText, pdfHasTextLayer } from "./pdf-raw-text.ts";
import { writeTextLayer } from "./pdf-text-layer.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");
const execFileAsync = promisify(execFile);
const python = path.join(env.CONDA_ENV_PATH, "python");

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("writeTextLayer", () => {
  it.skipIf(!existsSync(python))("puts each word where its box is, invisibly, on a copy of the PDF", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "text-layer-"));
    dirs.push(dir);
    const outPdfPath = path.join(dir, "page.ocr.pdf");
    await writeTextLayer({
      pdfPath: FIXTURE,
      outPdfPath,
      workDir: dir,
      pages: [{ page: 1, words: [{ text: "Chapter", bbox: [152, 149, 305, 188] }, { text: "Voyage", bbox: [444, 149, 583, 188] }] }],
    });
    expect(await pdfHasTextLayer(outPdfPath)).toBe(true);
    expect((await extractPdfRawText(outPdfPath))?.replace(/\s+/g, " ").trim()).toBe("Chapter Voyage");
    const { stdout } = await execFileAsync("pdftotext", ["-bbox", outPdfPath, "-"]);
    const words = [...stdout.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(\w+)<\/word>/g)].map((m) => [m[5], ...m.slice(1, 5).map((v) => Math.round(Number(v)))]);
    expect(words).toEqual([["Chapter", 152, 153, 305, 184], ["Voyage", 444, 153, 583, 184]]);
  });
});
