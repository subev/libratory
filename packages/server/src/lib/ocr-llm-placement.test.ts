import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { rectsForRange } from "./cue-rects.ts";
import { collectBlocksFromMarkerOutput, type SourceBlock } from "./marker.ts";
import { normalizeBlocks } from "./normalizer.ts";
import { makeLlmOcrRunner, type RawLlmPage, type Reference } from "./ocr-llm.ts";
import { parseTsv } from "./ocr-tesseract.ts";
import { ensureSourceGeometry } from "./page-geometry.ts";
import { ensureTessdata, tesseractEnv } from "./tessdata.ts";

// The findings of the first AI-read book, kept as one path from placed words to the rects the
// reader draws, so a different placement can be judged on the same two questions: do the boxes
// stay on the page (a run of guessed words once ran off the right edge, and the viewer, which
// sizes a page to its content, drew that page at a quarter width), and does a cue land on its
// own lines rather than fall back to its block's box (a run hung off the wrong line once did)?

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");
const execFileAsync = promisify(execFile);
const python = path.join(env.CONDA_ENV_PATH, "python");

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("placement, copy, geometry and rects", () => {
  // Tesseract is run here directly, so the language packs are staged here too: on a fresh
  // checkout the directory exists only once something has asked for it, and whichever test file
  // ran first used to be that something
  beforeAll(() => ensureTessdata());

  it.skipIf(!existsSync(python))("keeps every box on the page and lands a cue on its lines, even where the local reader skipped words", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "placement-"));
    dirs.push(dir);
    // Tesseract's full reading is the "model" text; the reference the engine sees has lost the
    // first line's opening words, so those must remain unlocated.
    await execFileAsync("pdftoppm", ["-scale-to", "1600", "-jpeg", "-gray", FIXTURE, path.join(dir, "pg")]);
    const image = path.join(dir, (await readdir(dir)).find((f) => f.endsWith(".jpg"))!);
    const full = parseTsv((await execFileAsync("tesseract", [image, "-", "-l", "eng", "tsv"], { env: tesseractEnv(), maxBuffer: 64 * 1024 * 1024 })).stdout);
    expect(full.words.length).toBeGreaterThan(20);
    const skipped = full.words.slice(0, 3).map((w) => w.text);
    const crippled: Reference = { ...full, words: full.words.slice(3) };
    const transcription: RawLlmPage = {
      blocks: full.text.trim().split(/\n\n+/).map((paragraph) => ({ type: "text", text: paragraph.replace(/\s+/g, " ") })),
      furniture: [],
      continues: false,
    };

    const outDir = path.join(dir, "out");
    const outPdfPath = path.join(dir, "page.ocr.pdf");
    const stats = await makeLlmOcrRunner({ transcribe: async () => ({ page: transcription, inputTokens: 1, outputTokens: 1 }), reference: async () => crippled })({
      pdfPath: FIXTURE, outDir, outPdfPath, language: "en", workDir: path.join(dir, "work"), log: async () => {},
    });
    expect(stats.searchableCopy).toBe(true);
    expect(stats.meanPlaced).toBeGreaterThan(0.9);

    // Every line the reader's geometry sees is inside the page
    const geometry = await ensureSourceGeometry({ fileIndex: 0, filename: "page.ocr.pdf", pdfPath: outPdfPath, outDir });
    const page = geometry?.pages[0];
    if (!page?.native) throw new Error("Expected native OCR geometry");
    expect(page?.lines.length).toBeGreaterThan(3);
    for (const line of page!.lines) {
      expect(line.b[0]).toBeGreaterThanOrEqual(0);
      expect(line.b[1]).toBeGreaterThanOrEqual(0);
      expect(line.b[2]).toBeLessThanOrEqual(page!.w + 1);
      expect(line.b[3]).toBeLessThanOrEqual(page!.h + 1);
    }

    // The reader's own rect resolution over the chapter this layout would cut
    const flat = await collectBlocksFromMarkerOutput(outDir);
    const blocks: SourceBlock[] = flat.map((b) => ({ type: b.type, text: b.text, page: b.page, included: b.included, ...(b.polygon ? { polygon: b.polygon } : {}) }));
    expect(blocks.every((b) => b.polygon)).toBe(true);
    const { text, spans } = normalizeBlocks(blocks);
    const context = { cleanText: text, textMap: { version: 1 as const, spans }, blocks, page: () => ({ index: 0, geometry: page! }) };

    // The opening "Chapter 1." was entirely skipped; the rest keeps its measured lines.
    const firstSentenceEnd = text.search(/[.!?]/) + 1;
    expect(rectsForRange(context, 0, firstSentenceEnd, { linesOnly: true })).toEqual([]);
    const rects = rectsForRange(context, firstSentenceEnd, text.length, { linesOnly: true });
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) expect(rect[4]).toBeLessThan(600);
    // Missing words have no fabricated first-line position.
    const firstWord = rectsForRange(context, 0, skipped[0]!.length, { linesOnly: true });
    expect(firstWord).toEqual([]);
  }, 180_000);
});
