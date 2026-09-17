import { cleanText } from "./extracted-text.ts";
import { STANDARD_EXTRACTION } from "./extraction-presets.ts";
import { afterAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { OrderedReadError } from "./ocr-line-order.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../env.ts";

import { collectBlocksFromMarkerOutput, detectBoundaryIndices } from "./marker.ts";
import {
  LLM_LAYOUT_FILE,
  LLM_LAYOUT_META_FILE,
  LLM_PAGES_FILE,
  LlmPageParseError,
  RETRY_BELOW_RECALL,
  anchorHint,
  estimateLlmOcrCostUsd,
  fidelity,
  hasLlmLayout,
  joinContinuations,
  makeLlmOcrRunner,
  normalizeBlockType,
  normalizePage,
  pagesToRawText,
  removeLlmLayout,
  replaceWords,
  toMarkerJson,
  type LlmPage,
  type RawLlmPage,
  type Reference,
  type Transcriber,
} from "./ocr-llm.ts";
import { writeTextLayer, type TextLayerWriter } from "./pdf-text-layer.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");
const SOFT_HYPHEN = String.fromCharCode(0xad);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ocr-llm-"));
  dirs.push(dir);
  return dir;
}
const exists = (p: string) => stat(p).then(() => true, () => false);

const page = (blocks: LlmPage["blocks"], continues = false, furniture: string[] = []): LlmPage => ({ blocks, furniture, continues });

// A Tesseract reading of the text: every word boxed on its line, 10 px a letter and 30 px a line,
// on the 1133 × 1600 image the fixture renders to at LLM_PAGE_EDGE.
function ref(text: string): Reference {
  const words: Reference["words"] = [];
  text.split("\n").forEach((line, row) => {
    let x = 100;
    for (const word of line.split(/\s+/).filter(Boolean)) {
      words.push({ text: word, box: [x, 100 + row * 30, x + word.length * 10, 120 + row * 30], conf: 90, line: row });
      x += word.length * 10 + 10;
    }
  });
  return { text, words, width: 1133, height: 1600 };
}

const voyage: RawLlmPage = {
  blocks: [
    { type: "heading", level: 1, text: "Chapter 1. The Voyage Begins" },
    { type: "text", text: "The ship left the harbor at dawn, its sails catching the first light of morning." },
  ],
  furniture: [],
  continues: false,
};
const REFERENCE = "Chapter 1. The Voyage Begins\nThe ship left the harbor at dawn, its sails catching the first light of morning.\n";


describe("normalizePage", () => {
  it("accepts the model's names for the block fields and drops what it must not emit", () => {
    const raw: RawLlmPage = {
      blocks: [
        { type: "text", content: `необ${SOFT_HYPHEN}ходимото  търпение` },
        { type: "Section Header", level: null, text: "ГЛАВА I" },
        { type: "list-item", text: `first${ZERO_WIDTH_SPACE}` },
        { type: "footnote", text: "1 See page 4." },
        { type: "paragraph", text: "   " },
      ],
      furniture: [" 12 ", ""],
      continues: true,
    };
    expect(normalizePage(raw)).toEqual({
      blocks: [
        { type: "paragraph", text: "необходимото търпение" },
        { type: "heading", text: "ГЛАВА I" },
        { type: "list_item", text: "first" },
        { type: "other", text: "1 See page 4." },
      ],
      furniture: ["12"],
      continues: true,
    });
  });

  it("maps every spelling the model has used onto the four block types", () => {
    expect(normalizeBlockType("Heading")).toBe("heading");
    expect(normalizeBlockType("section_header")).toBe("heading");
    expect(normalizeBlockType("text")).toBe("paragraph");
    expect(normalizeBlockType("ListItem")).toBe("list_item");
    expect(normalizeBlockType("table")).toBe("other");
  });

  it("strips soft hyphens and zero-width marks without touching real hyphens", () => {
    expect(cleanText(`по-голям зна${SOFT_HYPHEN}харките`)).toBe("по-голям знахарките");
  });
});

describe("joinContinuations", () => {
  it("joins only the word a hyphen split across the page break, and leaves the rest on its own page", () => {
    const joined = joinContinuations([
      page([{ type: "paragraph", text: "The ship left the har-" }], true),
      page([{ type: "paragraph", text: "bor at dawn." }, { type: "paragraph", text: "Next." }]),
    ]);
    expect(joined[0]?.blocks).toEqual([{ type: "paragraph", text: "The ship left the harbor" }]);
    expect(joined[1]?.blocks).toEqual([{ type: "paragraph", text: "at dawn." }, { type: "paragraph", text: "Next." }]);
    const whole = joinContinuations([page([{ type: "paragraph", text: "the har-" }], true), page([{ type: "paragraph", text: "bor." }])]);
    expect(whole[0]?.blocks[0]?.text).toBe("the harbor.");
    expect(whole[1]?.blocks).toEqual([]);
  });

  // A block glued across pages carries one page and one polygon, so every cue in its second half
  // was drawn on the first page's box. Blocks stay with their pages; the reader spans a sentence.
  it("keeps a paragraph that continues on the next page as two blocks, one per page", () => {
    const joined = joinContinuations([
      page([{ type: "paragraph", text: "ends mid" }], true),
      page([{ type: "paragraph", text: "sentence here." }], true),
      page([{ type: "heading", level: 1, text: "Chapter 2" }]),
    ]);
    expect(joined[0]?.blocks[0]?.text).toBe("ends mid");
    expect(joined[1]?.blocks).toEqual([{ type: "paragraph", text: "sentence here." }]);
    expect(joined[2]?.blocks).toEqual([{ type: "heading", level: 1, text: "Chapter 2" }]);
  });

  it("leaves a page it could not read where it is", () => {
    const joined = joinContinuations([page([{ type: "paragraph", text: "open" }], true), null, page([{ type: "paragraph", text: "later" }])]);
    expect(joined).toEqual([page([{ type: "paragraph", text: "open" }], true), null, page([{ type: "paragraph", text: "later" }])]);
  });
});

describe("toMarkerJson", () => {
  it("emits one Page per PDF page with the heading level in the html, and the reader gets it back", async () => {
    const dir = await scratch();
    const json = toMarkerJson([
      page([{ type: "heading", level: 1, text: "Chapter 1. The <Voyage> Begins" }, { type: "paragraph", text: "Body & soul." }], false, ["5"]),
      null,
      page([{ type: "list_item", text: "an item" }, { type: "other", text: "a footnote" }]),
    ]);
    expect(json.children).toHaveLength(3);
    expect(json.children[0]?.children[0]).toMatchObject({ block_type: "SectionHeader", html: "<h1>Chapter 1. The &lt;Voyage&gt; Begins</h1>" });
    expect(json.children[1]?.children).toEqual([]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, LLM_LAYOUT_FILE), JSON.stringify(json));
    await writeFile(path.join(dir, LLM_LAYOUT_META_FILE), "{}");
    const blocks = await collectBlocksFromMarkerOutput(dir);
    expect(blocks.map((b) => [b.type, b.text, b.page, b.level ?? null, b.included])).toEqual([
      ["SectionHeader", "Chapter 1. The <Voyage> Begins", 1, 1, true],
      ["Text", "Body & soul.", 1, null, true],
      ["ListItem", "an item", 3, null, true],
      ["Text", "a footnote", 3, null, true],
    ]);
    expect(blocks.every((b) => b.polygon === undefined)).toBe(true);
  });

  it("writes a placed block's box as Marker's four corners", () => {
    const json = toMarkerJson([page([{ type: "paragraph", text: "placed", polygon: [10, 20, 110, 40] }])]);
    expect(json.children[0]?.children[0]?.polygon).toEqual([[10, 20], [110, 20], [110, 40], [10, 40]]);
  });

  it("separates pages with a form feed in the raw text so citations count pages the way pdftotext does", () => {
    expect(pagesToRawText([page([{ type: "paragraph", text: "one" }, { type: "paragraph", text: "two" }]), null, page([{ type: "paragraph", text: "three" }])])).toBe("one\n\ntwo\f\fthree");
  });
});

describe("fidelity", () => {
  it("scores a faithful transcription high and a page missing a paragraph low", () => {
    const reference = "The ship left the har-\nbor at dawn.\n\nNobody aboard knew what the islands held.\n";
    expect(fidelity("The ship left the harbor at dawn.\n\nNobody aboard knew what the islands held.", reference).recall).toBe(1);
    const short = fidelity("Nobody aboard knew what the islands held.", reference);
    expect(short.recall).toBeLessThan(RETRY_BELOW_RECALL);
    expect(short.precision).toBe(1);
  });

  it("ignores reference words in a script the model's text does not use", () => {
    // Surya read the bleed-through on a Bulgarian page as English and Chinese
    const reference = "Още по-големи бяха трудностите\nof of of the the the 年 年 一点";
    expect(fidelity("Още по-големи бяха трудностите", reference).recall).toBe(1);
  });
});

describe("anchorHint", () => {
  it("names the page's first and last lines from the local OCR and how much was missed", () => {
    const hint = anchorHint("first line of the page here\nmiddle of the page\nlast line of the page here\n", page([{ type: "paragraph", text: "last line of the page here" }]));
    expect(hint).toContain("«first line of the page here middle of the page»");
    expect(hint).toContain("«middle of the page last line of the page here»");
    expect(hint).toMatch(/about 6 words; a rough OCR counts about 16/);
  });

  it("says nothing when the local OCR saw nothing worth anchoring to", () => {
    expect(anchorHint("a b\n\n", page([]))).toBe("");
  });
});

describe("replaceWords", () => {
  it("renders the displayed crop rather than squeezing the full media box into its coordinates", async () => {
    const dir = await scratch();
    const exec = promisify(execFile);
    const python = path.join(env.CONDA_ENV_PATH, "python");
    const cropped = path.join(dir, "cropped.pdf");
    await exec(python, ["-c", `
import sys
from pypdf import PdfWriter
w = PdfWriter(clone_from=sys.argv[1])
w.pages[0].cropbox.lower_left = (100, 200)
w.pages[0].cropbox.upper_right = (1000, 1200)
w.write(sys.argv[2])
`, FIXTURE, cropped]);
    const run = makeLlmOcrRunner({
      transcribe: async () => ({ page: page([{ type: "paragraph", text: "Some text." }]), inputTokens: 0, outputTokens: 0 }),
      reference: async (image) => {
        const { stdout } = await exec(python, ["-c", "from PIL import Image; import sys; print(*Image.open(sys.argv[1]).size)", image]);
        expect(stdout.trim()).toBe("1440 1600");
        return ref("Some text.");
      },
    });
    await run({ pdfPath: cropped, outDir: path.join(dir, "out"), workDir: path.join(dir, "work"), language: "en", log: async () => {} });
  });

  it("places the saved transcription again with a new reference and rewrites the layout and the copy", async () => {
    const dir = await scratch();
    const outDir = path.join(dir, "out");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    const saved = page([{ type: "heading", level: 1, text: "Chapter 1. The Voyage Begins" }, { type: "paragraph", text: "The ship left the harbor at dawn.", polygon: [1, 1, 2, 2] }]);
    await writeFile(path.join(outDir, LLM_PAGES_FILE), JSON.stringify({ engine: "llm", model: "Saved model", pages: [saved] }));
    const layers: Parameters<TextLayerWriter>[0]["pages"][] = [];
    const stats = await replaceWords(
      { pdfPath: FIXTURE, outDir, outPdfPath: path.join(dir, "page.ocr.pdf"), language: "en", workDir: path.join(dir, "work"), log: async () => {} },
      { reference: async () => ref("Chapter 1. The Voyage Begins\nThe ship left the harbor at dawn."), writeTextLayer: async (input) => { layers.push(input.pages); await writeTextLayer(input); } },
    );
    expect(stats).toMatchObject({ pages: 1, meanPlaced: 1, searchableCopy: true });
    expect(layers[0]?.[0]?.words).toHaveLength(12);
    const blocks = await collectBlocksFromMarkerOutput(outDir);
    // The stale polygon is gone and the new one is in the page's points
    expect(blocks[1]?.polygon?.[0]?.[1]).toBeCloseTo(130 * 1754 / 1600, 3);
    expect(JSON.parse(await readFile(path.join(outDir, LLM_LAYOUT_META_FILE), "utf-8"))).toMatchObject({ model: "Saved model", placed: 1 });
  });

  it("keeps the previous PDF and layout when replacement writes an invalid copy", async () => {
    const dir = await scratch();
    const { mkdir } = await import("node:fs/promises");
    const outDir = path.join(dir, "out");
    await mkdir(outDir);
    await writeFile(path.join(outDir, LLM_PAGES_FILE), JSON.stringify({ model: "M", complete: true, pages: [page([{ type: "paragraph", text: "Some text." }])] }));
    const outPdfPath = path.join(dir, "page.ocr.pdf");
    await writeFile(outPdfPath, "previous PDF");
    await writeFile(path.join(outDir, LLM_LAYOUT_FILE), "previous layout");
    await expect(replaceWords({ pdfPath: FIXTURE, outDir, outPdfPath, language: "en", workDir: path.join(dir, "work"), log: async () => {} }, {
      reference: async () => ref("Some text."),
      writeTextLayer: async ({ outPdfPath: pending }) => { await copyFile(FIXTURE, pending); },
    })).rejects.toThrow("Could not replace the searchable PDF");
    expect(await readFile(outPdfPath, "utf-8")).toBe("previous PDF");
    expect(await readFile(path.join(outDir, LLM_LAYOUT_FILE), "utf-8")).toBe("previous layout");
    expect(await exists(`${outPdfPath}.pending.pdf`)).toBe(false);
  });

  it("leaves the copy alone when no reader could place anything", async () => {
    const dir = await scratch();
    const outDir = path.join(dir, "out");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, LLM_PAGES_FILE), JSON.stringify({ engine: "llm", model: "M", complete: true, pages: [page([{ type: "paragraph", text: "Some text." }])] }));
    const outPdfPath = path.join(dir, "page.ocr.pdf");
    await writeFile(outPdfPath, "the good copy");
    await expect(replaceWords({ pdfPath: FIXTURE, outDir, outPdfPath, language: "en", workDir: path.join(dir, "work"), log: async () => {} }, { reference: async () => null }))
      .rejects.toThrow("No local reader could place");
    expect(await readFile(outPdfPath, "utf-8")).toBe("the good copy");
    expect(await hasLlmLayout(outDir)).toBe(false);
  });

  it("refuses without a saved transcription", async () => {
    const dir = await scratch();
    await expect(replaceWords({ pdfPath: FIXTURE, outDir: path.join(dir, "none"), language: "en", workDir: path.join(dir, "work"), log: async () => {} }))
      .rejects.toThrow("No saved AI transcription");
  });
});

describe("estimateLlmOcrCostUsd", () => {
  it("prices a 300-page book in cents, not dollars", () => {
    expect(estimateLlmOcrCostUsd(300)).toBeCloseTo(0.3735, 3);
  });
});

describe("runLlmOcr", () => {
  it("reuses paid transcription after the output writer fails and keeps the previous PDF", async () => {
    const dir = await scratch();
    const input = { pdfPath: FIXTURE, outDir: path.join(dir, "out"), outPdfPath: path.join(dir, "page.ocr.pdf"), language: "en", workDir: path.join(dir, "work"), log: async () => {} };
    await writeFile(input.outPdfPath, "previous PDF");
    let calls = 0;
    const run = makeLlmOcrRunner({
      modelLabel: "M", reference: async () => ref(REFERENCE),
      transcribe: async () => { calls++; return { page: voyage, inputTokens: 1, outputTokens: 1 }; },
      writeTextLayer: async ({ outPdfPath }) => { await writeFile(outPdfPath, "partial PDF"); throw new Error("disk full"); },
    });
    expect((await run(input)).searchableCopy).toBe(false);
    expect(await readFile(input.outPdfPath, "utf-8")).toBe("previous PDF");
    expect(await exists(`${input.outPdfPath}.pending.pdf`)).toBe(false);
    expect(JSON.parse(await readFile(path.join(input.outDir, LLM_PAGES_FILE), "utf-8"))).toMatchObject({ complete: true, outputFailed: true });
    await run(input);
    expect(calls).toBe(1);
    await run({ ...input, extractionSettings: { ...STANDARD_EXTRACTION, prompt: "Keep dialect spelling" } });
    expect(calls).toBe(2);
  });

  it("uses the ordered path and persists line groups for later geometry refresh", async () => {
    const dir = await scratch();
    const line = { id: 1, text: "Echo", box: [100, 100, 180, 120] as [number, number, number, number] };
    const reading: Reference = { width: 1000, height: 1000, text: "Echo", words: [{ text: "Echo", box: line.box, conf: 99, line: 0 }] };
    let orderedCalls = 0;
    let transcribed: () => void = () => {};
    const transcriptionDone = new Promise<void>((resolve) => { transcribed = resolve; });
    const run = makeLlmOcrRunner({
      reference: async () => reading,
      transcribe: async () => { throw new Error("Standard path must not run"); },
      readLines: async (_input, options) => {
        options.onPage(1, [line]);
        await transcriptionDone;
        return new Map([[1, [line]]]);
      },
      readOrdered: async () => {
        orderedCalls++;
        transcribed();
        return { page: { blocks: [{ type: "other", text: "Echo" }], furniture: [], continues: false, lineGroups: [[line]] }, restoredLineIds: [], inputTokens: 7, outputTokens: 3 };
      },
    });
    const outDir = path.join(dir, "out");
    const stats = await run({ pdfPath: FIXTURE, outDir, language: "en", workDir: path.join(dir, "work"), log: async () => {}, extractionSettings: { ...STANDARD_EXTRACTION, lineOrdering: true } });
    const resumed = { pdfPath: FIXTURE, outDir, language: "en", workDir: path.join(dir, "work"), log: async () => {}, extractionSettings: { ...STANDARD_EXTRACTION, lineOrdering: true, omitVerseCounters: true } };
    expect((await run(resumed)).inputTokens).toBe(0);
    expect(JSON.parse(await readFile(path.join(outDir, LLM_PAGES_FILE), "utf-8")).omitVerseCounters).toBe(true);
    expect((await run({ ...resumed, extractionSettings: { ...resumed.extractionSettings, omitVerseCounters: false } })).inputTokens).toBe(0);
    expect(orderedCalls).toBe(1);
    expect(stats).toMatchObject({ inputTokens: 7, outputTokens: 3, meanPlaced: 1 });
    expect(JSON.parse(await readFile(path.join(outDir, LLM_PAGES_FILE), "utf-8")).pages[0].lineGroups).toEqual([[line]]);
  });

  it("saves rejected ordered responses with their page before failing without retries", async () => {
    const dir = await scratch();
    const line = { id: 1, text: "Echo", box: [100, 100, 180, 120] as [number, number, number, number] };
    let calls = 0;
    const run = makeLlmOcrRunner({
      transcribe: async () => { throw new Error("Standard path must not run"); },
      reference: async () => null,
      readLines: async (_input, options) => { options.onPage(1, [line]); return new Map([[1, [line]]]); },
      readOrdered: async () => { calls++; throw new OrderedReadError("ordering", new Error("Missing line 1"), [line], { groups: [] }, '{"groups":[]}'); },
    });
    const outDir = path.join(dir, "out");
    await expect(run({ pdfPath: FIXTURE, outDir, language: "en", workDir: path.join(dir, "work"), log: async () => {}, extractionSettings: { ...STANDARD_EXTRACTION, lineOrdering: true } })).rejects.toThrow("page 1/1: ordering: Missing line 1");
    const saved = (await readdir(outDir)).find((name) => name.startsWith("ocr-failure-page-1-"));
    if (!saved) throw new Error("Missing diagnostic file");
    expect(JSON.parse(await readFile(path.join(outDir, saved), "utf8"))).toMatchObject({ page: 1, stage: "ordering", response: '{"groups":[]}', lines: [line] });
    expect(calls).toBe(1);
  });

  it("writes the layout the chapter pipeline reads, returns the raw text, and counts tokens", async () => {
    const dir = await scratch();
    const calls: { pageNumber: number; mediaType: string; hint: string; bytes: number }[] = [];
    const layers: Parameters<TextLayerWriter>[0]["pages"][] = [];
    // A writer that leaves no text layer behind: the run must say so and go on without the copy
    const writeTextLayer: TextLayerWriter = async ({ pdfPath, outPdfPath, pages }) => {
      layers.push(pages);
      await copyFile(pdfPath, outPdfPath);
    };
    const transcribe: Transcriber = async ({ image, mediaType, pageNumber, hint }) => {
      calls.push({ pageNumber, mediaType, hint, bytes: image.length });
      return { page: voyage, inputTokens: 1000, outputTokens: 200 };
    };
    const logs: string[] = [];
    const stats = await makeLlmOcrRunner({ transcribe, reference: async () => ref(REFERENCE), modelLabel: "Test model", writeTextLayer })({
      pdfPath: FIXTURE,
      outDir: path.join(dir, "out"),
      outPdfPath: path.join(dir, "page.ocr.pdf"),
      language: "en",
      workDir: path.join(dir, "work"),
      log: async (m) => { logs.push(m); },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pageNumber: 1, hint: "" });
    expect(["image/webp", "image/jpeg"]).toContain(calls[0]?.mediaType);
    expect(calls[0]?.bytes).toBeGreaterThan(1000);
    expect(stats).toMatchObject({ pages: 1, inputTokens: 1000, outputTokens: 200, meanRecall: 1, lowRecallFraction: 0, flaggedPages: [], meanPlaced: 1, searchableCopy: false });
    expect(stats.rawText).toContain("Voyage");

    // Every word placed, handed to the writer in the page's points (1241 pt across 1133 px)
    expect(layers).toHaveLength(1);
    expect(layers[0]?.[0]?.page).toBe(1);
    expect(layers[0]?.[0]?.words.map((w) => w.text).join(" ")).toBe(REFERENCE.replace("\n", " ").trim());
    expect(layers[0]?.[0]?.words[0]?.bbox[0]).toBeCloseTo(100 * 1241 / 1133, 3);
    expect(logs.some((l) => l.startsWith("No searchable copy for the AI's reading"))).toBe(true);
    expect(await exists(path.join(dir, "page.ocr.pdf"))).toBe(false);

    expect(await hasLlmLayout(path.join(dir, "out"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, "out", LLM_PAGES_FILE), "utf-8")).pages[0].blocks[0]).toEqual({ type: "heading", level: 1, text: "Chapter 1. The Voyage Begins" });
    const blocks = await collectBlocksFromMarkerOutput(path.join(dir, "out"));
    expect(blocks.map((b) => b.type)).toEqual(["SectionHeader", "Text"]);
    // The heading's box: five words on the first line, scaled to points
    expect(blocks[0]?.polygon?.[0]).toEqual([100 * 1241 / 1133, 100 * 1754 / 1600]);
    expect(blocks[1]?.polygon?.[2]?.[1]).toBeCloseTo(150 * 1754 / 1600, 3);
    expect(detectBoundaryIndices(blocks)).toBeNull();
    expect(JSON.parse(await readFile(path.join(dir, "out", LLM_LAYOUT_META_FILE), "utf-8"))).toMatchObject({ engine: "llm", model: "Test model", pages: 1 });
    expect(logs.some((l) => l.includes("0/1 pages cached; 1 remaining with Test model"))).toBe(true);
    expect(logs.some((l) => l.includes("100% placed on the page"))).toBe(true);
    expect(await exists(path.join(dir, "work"))).toBe(false);

    await removeLlmLayout(path.join(dir, "out"));
    expect(await hasLlmLayout(path.join(dir, "out"))).toBe(false);
  });

  it("asks a second time with anchors when the answer is short of the local OCR, and keeps the better one", async () => {
    const dir = await scratch();
    const hints: string[] = [];
    const transcribe: Transcriber = async ({ hint }) => {
      hints.push(hint);
      const short: RawLlmPage = { blocks: [{ type: "text", text: "The ship left the harbor at dawn." }], furniture: [], continues: false };
      return { page: hint ? voyage : short, inputTokens: 1, outputTokens: 1 };
    };
    const stats = await makeLlmOcrRunner({ transcribe, reference: async () => ref(REFERENCE) })({
      pdfPath: FIXTURE,
      outDir: path.join(dir, "out"),
      language: "en",
      workDir: path.join(dir, "work"),
      log: async () => {},
    });
    expect(hints).toHaveLength(2);
    expect(hints[1]).toContain("text was missed");
    expect(stats.flaggedPages).toEqual([]);
    expect(stats.inputTokens).toBe(2);
    expect(stats.rawText).toContain("Chapter 1");
  });

  it("flags a page that stays short after its second look and still writes the layout", async () => {
    const dir = await scratch();
    const short: RawLlmPage = { blocks: [{ type: "text", text: "The ship left the harbor at dawn." }], furniture: [], continues: false };
    const logs: string[] = [];
    const stats = await makeLlmOcrRunner({ transcribe: async () => ({ page: short, inputTokens: 1, outputTokens: 1 }), reference: async () => ref(REFERENCE) })({
      pdfPath: FIXTURE,
      outDir: path.join(dir, "out"),
      language: "en",
      workDir: path.join(dir, "work"),
      log: async (m) => { logs.push(m); },
    });
    expect(stats.flaggedPages).toEqual([1]);
    expect(stats.lowRecallFraction).toBe(1);
    expect(logs.some((l) => l.includes("check them in the structure view: 1"))).toBe(true);
    expect(await hasLlmLayout(path.join(dir, "out"))).toBe(true);
  });

  it("takes one second look at most, even when the reference gives it nothing to anchor to", async () => {
    const dir = await scratch();
    let calls = 0;
    const short: RawLlmPage = { blocks: [{ type: "text", text: "dawn" }], furniture: [], continues: false };
    const stats = await makeLlmOcrRunner({ transcribe: async () => { calls++; return { page: short, inputTokens: 1, outputTokens: 1 }; }, reference: async () => ref("a b\nc d\n" + REFERENCE.split("\n")[1]) })({
      pdfPath: FIXTURE, outDir: path.join(dir, "out"), language: "en", workDir: path.join(dir, "work"), log: async () => {},
    });
    expect(calls).toBeLessThanOrEqual(2);
    expect(stats.flaggedPages).toEqual([1]);
  });

  it("keeps the first answer when the anchored second look comes back unparseable", async () => {
    const dir = await scratch();
    let calls = 0;
    const transcribe: Transcriber = async () => {
      calls++;
      if (calls === 2) throw new LlmPageParseError(new Error("garbled"), 3, 3);
      return { page: { blocks: [{ type: "text", text: "The ship left the harbor at dawn." }], furniture: [], continues: false }, inputTokens: 1, outputTokens: 1 };
    };
    const stats = await makeLlmOcrRunner({ transcribe, reference: async () => ref(REFERENCE) })({
      pdfPath: FIXTURE, outDir: path.join(dir, "out"), language: "en", workDir: path.join(dir, "work"), log: async () => {},
    });
    expect(calls).toBe(2);
    expect(stats.flaggedPages).toEqual([1]);
    expect(stats.inputTokens).toBe(4);
    expect(stats.rawText).toContain("harbor");
  });

  it("retries an unparseable answer but stops the run on a provider error", async () => {
    const dir = await scratch();
    let attempts = 0;
    const flaky: Transcriber = async () => {
      attempts++;
      if (attempts === 1) throw new LlmPageParseError(new Error("not json"), 5, 5);
      return { page: voyage, inputTokens: 1, outputTokens: 1 };
    };
    const stats = await makeLlmOcrRunner({ transcribe: flaky, reference: async () => null })({
      pdfPath: FIXTURE, outDir: path.join(dir, "out"), language: null, workDir: path.join(dir, "work"), log: async () => {},
    });
    expect(attempts).toBe(2);
    expect(stats).toMatchObject({ inputTokens: 6, outputTokens: 6, meanRecall: null, lowRecallFraction: null });

    const billing: Transcriber = async () => { throw new Error("DeepSeek API error 402: Insufficient Balance"); };
    await expect(makeLlmOcrRunner({ transcribe: billing, reference: async () => null })({
      pdfPath: FIXTURE, outDir: path.join(dir, "out2"), language: null, workDir: path.join(dir, "work2"), log: async () => {},
    })).rejects.toThrow("Insufficient Balance");
    expect(await hasLlmLayout(path.join(dir, "out2"))).toBe(false);
  });

  it("keeps the pages it paid for, and the next run reads only the rest", async () => {
    const dir = await scratch();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const twoPages = path.join(dir, "two.pdf");
    await promisify(execFile)("qpdf", ["--empty", "--pages", FIXTURE, "1", FIXTURE, "1", "--", twoPages]);
    const outDir = path.join(dir, "out");
    const base = { pdfPath: twoPages, outDir, language: "en", workDir: path.join(dir, "work"), log: async () => {} };

    // Page 2 fails after page 1 has landed
    let firstDone: () => void = () => {};
    const landed = new Promise<void>((resolve) => { firstDone = resolve; });
    const failing: Transcriber = async ({ pageNumber }) => {
      if (pageNumber === 1) { setTimeout(firstDone, 50); return { page: voyage, inputTokens: 7, outputTokens: 7 }; }
      await landed;
      await new Promise((r) => setTimeout(r, 100));
      throw new Error("DeepSeek API error 503");
    };
    await expect(makeLlmOcrRunner({ transcribe: failing, reference: async () => ref(REFERENCE), modelLabel: "M" })(base)).rejects.toThrow("503");
    const partial = JSON.parse(await readFile(path.join(outDir, LLM_PAGES_FILE), "utf-8"));
    expect(partial.complete).toBe(false);
    expect(partial.pages[0]?.blocks).toHaveLength(2);
    expect(partial.pages[1]).toBeNull();
    // Files saved before presets existed have no settings hash and mean Standard.
    delete partial.settingsKey;
    await writeFile(path.join(outDir, LLM_PAGES_FILE), JSON.stringify(partial));
    expect(await hasLlmLayout(outDir)).toBe(false);
    await expect(replaceWords(base)).rejects.toThrow("incomplete");

    const calls: number[] = [];
    const working: Transcriber = async ({ pageNumber }) => { calls.push(pageNumber); return { page: voyage, inputTokens: 1, outputTokens: 1 }; };
    const logs: string[] = [];
    const stats = await makeLlmOcrRunner({ transcribe: working, reference: async () => ref(REFERENCE), modelLabel: "M" })({ ...base, log: async (m) => { logs.push(m); } });
    expect(calls).toEqual([2]);
    expect(stats).toMatchObject({ pages: 2, inputTokens: 1 });
    expect(logs.some((l) => l.includes("1/2 pages cached"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(outDir, LLM_PAGES_FILE), "utf-8")).complete).toBe(true);
    expect((await collectBlocksFromMarkerOutput(outDir)).map((b) => b.page)).toEqual([1, 1, 2, 2]);
  });

  it("finishes other ordered pages after a rejected response, then resumes only the rejected page", async () => {
    const dir = await scratch();
    const pdfPath = path.join(dir, "five.pdf");
    await promisify(execFile)("qpdf", ["--empty", "--pages", ...Array.from({ length: 5 }, () => [FIXTURE, "1"]).flat(), "--", pdfPath]);
    const outDir = path.join(dir, "out");
    const base = { pdfPath, outDir, language: "en", workDir: path.join(dir, "work"), log: async () => {}, extractionSettings: { ...STANDARD_EXTRACTION, lineOrdering: true } };
    const calls: number[] = [];
    let fail = true;
    const run = makeLlmOcrRunner({
      reference: async () => null,
      transcribe: async () => { throw new Error("Standard path must not run"); },
      readLines: async (_input, options) => {
        const pages = new Map(options.neededPages.map((page) => [page, [{ id: page, text: "Text", box: [100, 100, 200, 120] as [number, number, number, number] }]]));
        for (const [page, lines] of pages) options.onPage(page, lines);
        return pages;
      },
      readOrdered: async (_image, _mediaType, lines) => {
        const line = lines[0];
        if (!line) throw new Error("No line");
        calls.push(line.id);
        if (fail && line.id === 1) throw new OrderedReadError("ordering", new Error("Missing line 1"), lines, { groups: [] }, '{"groups":[]}');
        return { page: { blocks: [{ type: "paragraph", text: "Text" }], furniture: [], continues: false, lineGroups: [lines] }, restoredLineIds: [], inputTokens: 1, outputTokens: 1 };
      },
    });
    await expect(run(base)).rejects.toThrow("Pages requiring review: 1; 4/5 pages saved");
    expect(calls.sort()).toEqual([1, 2, 3, 4, 5]);
    const partial = JSON.parse(await readFile(path.join(outDir, LLM_PAGES_FILE), "utf8"));
    expect(partial.complete).toBe(false);
    expect(partial.pages[0]).toBeNull();
    expect(partial.pages.slice(1).every(Boolean)).toBe(true);
    expect(await hasLlmLayout(outDir)).toBe(false);
    fail = false;
    calls.length = 0;
    await run(base);
    expect(calls).toEqual([1]);
    expect(await hasLlmLayout(outDir)).toBe(true);
  });
});

it("preserves semantic kinds and verse breaks through normalization and layout export", () => {
  const page = normalizePage({ blocks: [
    { type: "other", kind: "verse", text: "First verse\nsecond verse\n\nnew stanza" },
    { type: "paragraph", kind: "prose", text: "A wrapped\nparagraph." },
    { type: "other", kind: "footnote", text: "14 A footnote." },
  ], furniture: [], continues: false });
  expect(page.blocks.map((b) => b.text)).toEqual(["First verse\nsecond verse\n\nnew stanza", "A wrapped paragraph.", "14 A footnote."]);
  const output = toMarkerJson([page]).children[0]?.children;
  expect(output?.map((b) => b.text_kind)).toEqual(["verse", "prose", "footnote"]);
});

it("excludes only isolated numeric page furniture with local line evidence", async () => {
  const { isPrintedPageNumber, pagesToRawText } = await import("./ocr-llm.ts");
  const page: LlmPage = {
    blocks: [{ type: "paragraph", kind: "verse", text: "35 Body" }, { type: "other", kind: "furniture", text: "181" }],
    furniture: [], continues: false,
    lineGroups: [[{ id: 1, text: "35 Body", box: [20, 200, 250, 220] }], [{ id: 2, text: "181", box: [850, 900, 900, 920] }]],
  };
  expect(isPrintedPageNumber(page, 1)).toBe(true);
  expect(isPrintedPageNumber(page, 0)).toBe(false);
  expect(isPrintedPageNumber({ ...page, lineGroups: undefined }, 1)).toBe(false);
  const last = page.blocks[1];
  const first = page.blocks[0];
  if (!first || !last) throw Error("Missing fixture block");
  expect(isPrintedPageNumber({ ...page, blocks: [first, { ...last, text: "A performance note" }] }, 1)).toBe(false);
  last.narrationExcluded = true;
  expect(pagesToRawText([page])).toBe("35 Body");
  expect(toMarkerJson([page]).children[0]?.children[1]?.block_type).toBe("PageFooter");
});
