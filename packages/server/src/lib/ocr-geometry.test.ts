import { describe, expect, it } from "vitest";
import { placeOcrPage, reconcileNativeBlocks } from "./ocr-geometry.ts";
import { rectsForRange, type RectContext } from "./cue-rects.ts";
import type { OcrPage } from "./ocr-tesseract.ts";

const reference: OcrPage = { width: 500, height: 1000, text: "", words: [
  { text: "Before", box: [10, 100, 50, 110], line: 0, conf: 90 },
  { text: "selected", box: [60, 101, 100, 109], line: 0, conf: 90 },
  { text: "words", box: [110, 100, 150, 111], line: 0, conf: 90 },
  { text: "continue", box: [10, 120, 70, 130], line: 1, conf: 90 },
  { text: "here", box: [80, 121, 110, 129], line: 1, conf: 90 },
  { text: "After", box: [120, 120, 160, 131], line: 1, conf: 90 },
] };
const text = "Before selected words continue here After";
function example(model = text, local = reference) {
  const placed = placeOcrPage([model], local, { width: 500, height: 1000 }, 0);
  const context: RectContext = { cleanText: model,
    textMap: { version: 1, spans: [{ block: 0, start: 0, end: model.length }] },
    blocks: [{ text: model, type: "Text", page: 1, included: true }],
    page: () => ({ index: 3, geometry: placed.geometry }),
  };
  return { placed, context };
}

describe("native OCR geometry", () => {
  it("draws partial first and last lines without including the surrounding words", () => {
    const { context } = example();
    expect(rectsForRange(context, text.indexOf("selected"), text.indexOf(" After"))).toEqual([
      [3, 1200, 1000, 1800, 110], [3, 200, 1200, 2000, 110],
    ]);
  });

  it("uses measured word height for real word timing and line height for the band", () => {
    const { context } = example();
    const start = text.indexOf("selected");
    expect(rectsForRange(context, start, start + 8, { linesOnly: true })).toEqual([[3, 1200, 1010, 800, 80]]);
    expect(rectsForRange(context, start, start + 8)).toEqual([[3, 1200, 1000, 800, 110]]);
  });

  it("leaves unmatched text unhighlighted even when an old block polygon exists", () => {
    const model = "Before invented selected words continue here After";
    const { context } = example(model);
    const block = context.blocks[0];
    if (!block) throw new Error("Missing fixture block");
    block.polygon = [[0, 0], [500, 0], [500, 1000], [0, 1000]];
    expect(rectsForRange(context, 7, 15)).toEqual([]);
  });

  it("does not paint across an unselected printed word within a line", () => {
    const { context } = example("Before words continue here After");
    expect(rectsForRange(context, 0, 12)).toEqual([[3, 200, 1000, 800, 110], [3, 2200, 1000, 800, 110]]);
  });

  it("keeps distinct lines instead of capping them into a tall rectangle", () => {
    const words = Array.from({ length: 6 }, (_, i) => ({ text: `word${i}`, box: [10, 100 + i * 20, 60, 110 + i * 20] as [number, number, number, number], conf: 90, line: i }));
    const model = words.map((w) => w.text).join(" ");
    const { context } = example(model, { ...reference, words });
    expect(rectsForRange(context, 0, model.length)).toHaveLength(6);
  });

  it("writes the model's spelling into the PDF using the measured coordinates without shrinking", () => {
    const { placed } = example("Before selected wards continue here After");
    expect(placed.layer[2]).toEqual({ text: "wards", bbox: reference.words[2]?.box });
    expect(placed.geometry.native?.words[2]?.text).toBe("words");
  });

  it("splits a joined word across its actual printed lines in both PDF and cues", () => {
    const { placed, context } = example("harbor", { ...reference, words: [
      { text: "har-", box: [300, 100, 330, 110], conf: 90, line: 0 },
      { text: "bor", box: [10, 120, 40, 130], conf: 90, line: 1 },
    ] });
    expect(placed.layer).toEqual([{ text: "har", bbox: [300, 100, 330, 110] }, { text: "bor", bbox: [10, 120, 40, 130] }]);
    expect(rectsForRange(context, 0, 6, { linesOnly: true })).toEqual([[3, 6000, 1000, 600, 100], [3, 200, 1200, 600, 100]]);
  });
});


it("keeps the next page's offsets aligned after joining a hyphenated word", () => {
  const { placed } = example("continue here After");
  reconcileNativeBlocks([placed.geometry], [["here After"]]);
  const block = placed.geometry.native?.blocks[0];
  expect(block?.text).toBe("here After");
  expect(block?.words.map(({ start, end }) => [start, end])).toEqual([[0, 4], [5, 10]]);
});

it("keeps offsets when the same block continues from one page and onto the next", () => {
  const placed = placeOcrPage(["bor comes fur-"], { ...reference, words: [
    { text: "bor", box: [10, 100, 40, 110], conf: 90, line: 0 },
    { text: "comes", box: [50, 100, 100, 110], conf: 90, line: 0 },
    { text: "fur-", box: [110, 100, 150, 110], conf: 90, line: 0 },
  ] }, { width: 500, height: 1000 }, 0);
  reconcileNativeBlocks([placed.geometry], [["comes further"]]);
  expect(placed.geometry.native?.blocks[0]?.words).toEqual([
    { start: 0, end: 5, indices: [1] }, { start: 6, end: 13, indices: [2] },
  ]);
});
