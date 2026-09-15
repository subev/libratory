import { afterAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectBlocksFromMarkerOutput, detectBoundaryIndices } from "./marker.ts";
import {
  LLM_LAYOUT_FILE,
  LLM_LAYOUT_META_FILE,
  LLM_PAGES_FILE,
  LlmPageParseError,
  RETRY_BELOW_RECALL,
  anchorHint,
  cleanText,
  combineReadings,
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
import type { TextLayerWriter } from "./pdf-text-layer.ts";

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

describe("placement with two readers", () => {
  it("keeps whichever reader placed more of the page, and names the words they disagree on", async () => {
    const dir = await scratch();
    // Vision-like boxes that read the page as noise, Tesseract-like text that read it well
    const noise = { ...ref("xx yy zz"), width: 1133, height: 1600 };
    const good = ref(REFERENCE);
    const reference = combineReadings(good, noise)!;
    expect(reference.alternates).toEqual([good]);
    const logs: string[] = [];
    const stats = await makeLlmOcrRunner({ transcribe: async () => ({ page: { ...voyage, blocks: [voyage.blocks[0]!, { type: "text", text: "The ship left the harbor at dawn, its sails catching the first light of morning." }] }, inputTokens: 1, outputTokens: 1 }), reference: async () => reference })({
      pdfPath: FIXTURE, outDir: path.join(dir, "out"), language: "en", workDir: path.join(dir, "work"), log: async (m) => { logs.push(m); },
    });
    expect(stats.meanPlaced).toBe(1);
    const disagreeing = combineReadings(ref("Chapter 1. The Voyage Begins\nThe ship left the harbar at dawn, its sails catching the first light of morning."), null)!;
    const flagged = await makeLlmOcrRunner({ transcribe: async () => ({ page: voyage, inputTokens: 1, outputTokens: 1 }), reference: async () => disagreeing })({
      pdfPath: FIXTURE, outDir: path.join(dir, "out2"), language: "en", workDir: path.join(dir, "work2"), log: async (m) => { logs.push(m); },
    });
    expect(flagged.meanPlaced).toBe(1);
    expect(logs.some((l) => l.includes("1 word the readers disagree on (harbor)"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, "out2", LLM_LAYOUT_META_FILE), "utf-8")).doubtful).toEqual({ 1: ["harbor"] });
  });
});

describe("replaceWords", () => {
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
      { reference: async () => ref("Chapter 1. The Voyage Begins\nThe ship left the harbor at dawn."), writeTextLayer: async ({ pdfPath, outPdfPath, pages }) => { layers.push(pages); await copyFile(pdfPath, outPdfPath); } },
    );
    expect(stats).toMatchObject({ pages: 1, meanPlaced: 1, searchableCopy: false });
    expect(layers[0]?.[0]?.words).toHaveLength(12);
    const blocks = await collectBlocksFromMarkerOutput(outDir);
    // The stale polygon is gone and the new one is in the page's points
    expect(blocks[1]?.polygon?.[0]?.[1]).toBeCloseTo(130 * 1241 / 1133, 3);
    expect(JSON.parse(await readFile(path.join(outDir, LLM_LAYOUT_META_FILE), "utf-8"))).toMatchObject({ model: "Saved model", placed: 1 });
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

describe("combineReadings", () => {
  it("takes the boxes from the box reader and the text from the text reader, and copes with either missing", () => {
    const text = ref("Chapter 1. The Voyage Begins");
    const boxes = { ...ref("Chapter I. The Voyage Begins"), width: 1000, height: 1400 };
    const both = combineReadings(text, boxes)!;
    expect(both.text).toBe(text.text);
    expect(both.words).toBe(boxes.words);
    expect([both.width, both.height]).toEqual([1000, 1400]);
    // Boxes only: nothing for the fidelity check to compare against, the words still get placed
    expect(combineReadings(null, boxes)).toMatchObject({ text: "", width: 1000 });
    expect(combineReadings(text, null)?.words).toBe(text.words);
    expect(combineReadings(null, null)).toBeNull();
  });
});

describe("estimateLlmOcrCostUsd", () => {
  it("prices a 300-page book in cents, not dollars", () => {
    expect(estimateLlmOcrCostUsd(300)).toBeCloseTo(0.3735, 3);
  });
});

describe("runLlmOcr", () => {
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
    expect(blocks[0]?.polygon?.[0]).toEqual([100 * 1241 / 1133, 100 * 1241 / 1133]);
    expect(blocks[1]?.polygon?.[2]?.[1]).toBeCloseTo(150 * 1241 / 1133, 3);
    expect(detectBoundaryIndices(blocks)).toBeNull();
    expect(JSON.parse(await readFile(path.join(dir, "out", LLM_LAYOUT_META_FILE), "utf-8"))).toMatchObject({ engine: "llm", model: "Test model", pages: 1 });
    expect(logs.some((l) => l.includes("Reading 1 page with Test model"))).toBe(true);
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
    expect(await hasLlmLayout(outDir)).toBe(false);
    await expect(replaceWords(base)).rejects.toThrow("incomplete");

    const calls: number[] = [];
    const working: Transcriber = async ({ pageNumber }) => { calls.push(pageNumber); return { page: voyage, inputTokens: 1, outputTokens: 1 }; };
    const logs: string[] = [];
    const stats = await makeLlmOcrRunner({ transcribe: working, reference: async () => ref(REFERENCE), modelLabel: "M" })({ ...base, log: async (m) => { logs.push(m); } });
    expect(calls).toEqual([2]);
    expect(stats).toMatchObject({ pages: 2, inputTokens: 1 });
    expect(logs.some((l) => l.includes("1 read by the run before"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(outDir, LLM_PAGES_FILE), "utf-8")).complete).toBe(true);
    expect((await collectBlocksFromMarkerOutput(outDir)).map((b) => b.page)).toEqual([1, 1, 2, 2]);
  });
});
