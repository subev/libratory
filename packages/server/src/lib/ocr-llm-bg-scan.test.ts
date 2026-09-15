import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { rectsForRange } from "./cue-rects.ts";
import { collectBlocksFromMarkerOutput, type SourceBlock } from "./marker.ts";
import { normalizeBlocks } from "./normalizer.ts";
import { joinContinuations, makeLlmOcrRunner, type LlmPage, type RawLlmPage, type Reference } from "./ocr-llm.ts";
import { parseTsv, type OcrPage, type PdfPageSize } from "./ocr-tesseract.ts";
import { parseVisionTable } from "./ocr-vision.ts";
import { ensureSourceGeometry } from "./page-geometry.ts";
import { placeBlocks } from "./word-alignment.ts";

// A real scanned book as the mock for the whole placement chain: the model's pages as read, the
// page sizes, and both local readers' word tables, captured once by scripts/capture-ocr-fixture.ts.
// No PDF, no OCR binary and no model call — every finding from that book is asserted here, so a
// different alignment, reader or writer is judged on the same pages. The fixture is a published
// book and stays out of the public repo (test/fixtures/private/ is gitignored); absent, this skips.

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/private/bg-scan");
const present = existsSync(path.join(FIXTURE, "pages.json"));
const python = path.join(env.CONDA_ENV_PATH, "python");
const execFileAsync = promisify(execFile);

type Fixture = { pages: (LlmPage | null)[]; sizes: PdfPageSize[]; vision: OcrPage[]; tesseract: OcrPage[] };

async function load(): Promise<Fixture> {
  const read = async (dir: string, parse: (s: string) => OcrPage) => {
    const files = (await readdir(path.join(FIXTURE, dir))).filter((f) => f.endsWith(".tsv")).sort();
    return Promise.all(files.map(async (f) => parse(await readFile(path.join(FIXTURE, dir, f), "utf-8"))));
  };
  return {
    pages: (JSON.parse(await readFile(path.join(FIXTURE, "pages.json"), "utf-8")) as { pages: (LlmPage | null)[] }).pages,
    sizes: JSON.parse(await readFile(path.join(FIXTURE, "sizes.json"), "utf-8")),
    vision: await read("vision", parseVisionTable),
    tesseract: await read("tesseract", parseTsv),
  };
}

const texts = (page: LlmPage | null | undefined) => page?.blocks.map((b) => b.text) ?? [];
const bounds = (p: OcrPage) => ({ width: p.width!, height: p.height! });

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe.skipIf(!present)("the Bulgarian scan", () => {
  it("places most of the model's words on every page, and Vision beats Tesseract where the scan is skewed or clipped", async () => {
    const f = await load();
    expect(f.vision).toHaveLength(f.pages.length);
    const share = (reader: OcrPage[], i: number) => placeBlocks(texts(f.pages[i]), reader[i]!.words, bounds(reader[i]!)).matchedShare ?? 0;
    const vision = f.pages.map((_, i) => share(f.vision, i));
    const tesseract = f.pages.map((_, i) => share(f.tesseract, i));
    expect(vision.reduce((a, s) => a + s, 0) / vision.length).toBeGreaterThan(0.9);
    for (const s of vision) expect(s).toBeGreaterThan(0.7);
    // Page 7 is small-type footnotes, page 17 is tilted and clipped at the left edge
    for (const page of [7, 17]) expect(vision[page - 1]).toBeGreaterThan(tesseract[page - 1]!);
  });

  it("keeps every placed box inside the page", async () => {
    const f = await load();
    for (const [i, page] of f.pages.entries()) {
      for (const reader of [f.vision[i]!, f.tesseract[i]!]) {
        for (const w of placeBlocks(texts(page), reader.words, bounds(reader)).words) {
          if (!w.box) continue;
          expect(w.box[0]).toBeGreaterThanOrEqual(0);
          expect(w.box[1]).toBeGreaterThanOrEqual(0);
          expect(w.box[2]).toBeLessThanOrEqual(reader.width!);
          expect(w.box[3]).toBeLessThanOrEqual(reader.height!);
        }
      }
    }
  });

  // Tesseract read only the right half of page 17's last lines; the model's "От тази категория
  // информаторки заслужава да се" then has no partner and must start that line, not hang off the
  // end of the poem above it.
  it("puts a line beginning the reader skipped at the start of that line", async () => {
    const f = await load();
    const reader = f.tesseract[16]!;
    const anchor = reader.words.find((w) => w.text.startsWith("споменат"))!;
    expect(reader.words.some((w) => w.text === "категория")).toBe(false);
    const placed = placeBlocks(texts(f.pages[16]), reader.words, bounds(reader));
    const from = placed.words.find((w) => w.text === "От" && placed.words[placed.words.indexOf(w) + 1]?.text === "тази")!;
    expect(from.matched).toBe(false);
    expect(from.box![2]).toBeLessThan(anchor.box[0]);
    expect(Math.abs(from.box![1] - anchor.box[1])).toBeLessThan(anchor.box[3] - anchor.box[1]);
    // Vision read the line, so with its words the same fragment is matched, not guessed
    const withVision = placeBlocks(texts(f.pages[16]), f.vision[16]!.words, bounds(f.vision[16]!));
    expect(withVision.words.find((w) => w.text === "категория")?.matched).toBe(true);
  });

  it("keeps a paragraph that runs onto the next page as two blocks, joining only a hyphen-split word", async () => {
    const f = await load();
    const joined = joinContinuations(f.pages);
    for (const [i, page] of f.pages.entries()) {
      const next = f.pages[i + 1];
      if (!page || !next) continue;
      const tail = page.blocks.at(-1)?.text ?? "";
      const glued = page.continues && /\p{L}-$/u.test(tail);
      expect(joined[i + 1]!.blocks.length).toBe(next.blocks.length - (glued && !next.blocks[0]!.text.includes(" ") ? 1 : 0));
      if (!glued) expect(joined[i]!.blocks.at(-1)?.text).toBe(tail);
    }
  });

  it.skipIf(!existsSync(python))("gives the reader line rects for nearly every sentence, through the real copy and geometry", async () => {
    const f = await load();
    const dir = await mkdtemp(path.join(tmpdir(), "bg-scan-"));
    dirs.push(dir);
    // The scans themselves are not needed: blank pages of the same sizes carry the same text layer
    const blank = path.join(dir, "blank.pdf");
    await writeFile(path.join(dir, "sizes.json"), JSON.stringify(f.sizes));
    await execFileAsync(python, ["-c", "import json,sys\nfrom pypdf import PdfWriter\nw=PdfWriter()\nfor s in json.load(open(sys.argv[1])): w.add_blank_page(width=s['width'], height=s['height'])\nw.write(sys.argv[2])", path.join(dir, "sizes.json"), blank]);
    const outDir = path.join(dir, "out");
    const outPdfPath = path.join(dir, "blank.ocr.pdf");
    let index = 0;
    const stats = await makeLlmOcrRunner({
      transcribe: async ({ pageNumber }) => ({ page: f.pages[pageNumber - 1] as unknown as RawLlmPage, inputTokens: 0, outputTokens: 0 }),
      reference: async (_image, pageNumber): Promise<Reference> => ({ ...f.vision[pageNumber - 1]!, text: f.tesseract[pageNumber - 1]!.text }),
    })({ pdfPath: blank, outDir, outPdfPath, language: "bg", workDir: path.join(dir, "work"), log: async () => { index++; } });
    expect(stats.searchableCopy).toBe(true);

    const geometry = (await ensureSourceGeometry({ fileIndex: 0, filename: "blank.ocr.pdf", pdfPath: outPdfPath, outDir }))!;
    expect(geometry.pages).toHaveLength(f.pages.length);
    // A string ending at the page edge reads back up to half a percent wider: the glyphless
    // font's advance, not the placement. A guessed run that ran off the page was four times wider.
    for (const page of geometry.pages) {
      for (const line of page.lines) {
        expect(line.b[0]).toBeGreaterThanOrEqual(0);
        expect(line.b[2]).toBeLessThanOrEqual(page.w * 1.01);
      }
    }

    const flat = await collectBlocksFromMarkerOutput(outDir);
    const blocks: SourceBlock[] = flat.map((b) => ({ type: b.type, text: b.text, page: b.page, included: b.included, ...(b.polygon ? { polygon: b.polygon } : {}) }));
    const { text, spans } = normalizeBlocks(blocks);
    const context = { cleanText: text, textMap: { version: 1 as const, spans }, blocks, page: (p: number) => ({ index: p - 1, geometry: geometry.pages[p - 1] ?? null }) };
    let sentences = 0;
    let onLines = 0;
    for (const m of text.matchAll(/[^.!?]+[.!?]+/g)) {
      if (m[0].trim().split(/\s+/).length < 4) continue;
      sentences++;
      // linesOnly: a sentence the reader cannot put on its lines gets nothing, never the block box
      if (rectsForRange(context, m.index, m.index + m[0].length, { linesOnly: true }).length > 0) onLines++;
    }
    expect(sentences).toBeGreaterThan(200);
    expect(onLines / sentences).toBeGreaterThan(0.95);
  }, 300_000);
});
