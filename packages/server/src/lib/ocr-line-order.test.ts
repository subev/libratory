import { describe, expect, it } from "vitest";
import { orderedTranscription, validateLineOrder, type OcrLine } from "./ocr-line-order.ts";
import { placeOrderedPage } from "./ocr-ordered-placement.ts";

const lines: OcrLine[] = [
  { id: 1, text: "Echo", box: [50, 100, 150, 120] },
  { id: 2, text: "Echo", box: [600, 100, 700, 120] },
  { id: 3, text: "1937", box: [50, 150, 150, 170] },
];
describe("fixed line ordering", () => {
  it("preserves measured lines while changing the reading order", () => {
    const ordered = validateLineOrder(lines, [[2], [1], [3]]);
    expect(ordered[0]?.[0]).toBe(lines[1]);
    expect(ordered.flat().map((l) => l.text)).toEqual(["Echo", "Echo", "1937"]);
  });
  it.each([[[1], [2]], [[1], [2], [2], [3]], [[1], [2], [3], [4]], [[1, 2], [3]], [[], [1], [2], [3]]])("rejects missing, repeated, invented and cross-column groups: %j", (...groups) => {
    expect(() => validateLineOrder(lines, groups)).toThrow();
  });
  it("retains notes and page numbers regardless of ordering model labels", () => {
    const note = lines[2];
    if (!note) throw new Error("Missing test line");
    const page = orderedTranscription([[note]], [{ group: 0, type: "other", text: "1937", level: null }]);
    expect(page.furniture).toEqual([]);
    expect(page.blocks[0]?.text).toBe("1937");
    expect(() => orderedTranscription([[note]], [])).toThrow(/omitted/);
    expect(() => orderedTranscription([[note]], [{ group: 1, type: "other", text: "1937", level: null }])).toThrow(/reordered/);
  });
  it("places identical text only in its own column and keeps native indices valid", () => {
    const groups = validateLineOrder(lines, [[2], [1], [3]]);
    const page = orderedTranscription(groups, groups.map((g, group) => ({ group, type: "other", text: g.map((l) => l.text).join(" "), level: null })));
    const placed = placeOrderedPage(page, { width: 1000, height: 1000, text: "Echo Echo 1937", words: lines.map((l) => ({ text: l.text, box: l.box, conf: 99, line: 0 })) }, { width: 1000, height: 1000 }, 0);
    expect(placed.geometry.native?.words.map((w) => w.line)).toEqual([2, 1, 3]);
    expect(placed.words[0]?.bbox).toEqual(lines[1]?.box);
    expect(placed.words[1]?.bbox).toEqual(lines[0]?.box);
    for (const b of placed.geometry.native?.blocks ?? []) for (const w of b.words) for (const n of w.indices) expect(placed.geometry.native?.words[n]).toBeDefined();

  });

  it("aligns words in the requested line order inside a group", () => {
    const input: OcrLine[] = [
      { id: 1, text: "Alpha", box: [50, 100, 150, 120] },
      { id: 2, text: "Omega", box: [50, 150, 150, 170] },
    ];
    const groups = validateLineOrder(input, [[2, 1]]);
    const page = orderedTranscription(groups, [{ group: 0, type: "paragraph", text: "Omega Alpha", level: null }]);
    const placed = placeOrderedPage(page, { width: 1000, height: 1000, text: "Alpha Omega",
      words: input.map((line) => ({ text: line.text, box: line.box, conf: 99, line: line.id })),
    }, { width: 1000, height: 1000 }, 0);
    expect(placed.placed).toBe(1);
    expect(placed.words.map((word) => word.text)).toEqual(["Omega", "Alpha"]);
    expect(placed.geometry.native?.words.map((word) => word.line)).toEqual([2, 1]);
  });
  it("rejects row-by-row alternation between two verse columns", () => {
    const rows: OcrLine[] = [
      { id: 1, text: "Left first", box: [50, 100, 200, 120] },
      { id: 2, text: "Right first", box: [600, 100, 800, 120] },
      { id: 3, text: "Left second", box: [50, 125, 200, 145] },
      { id: 4, text: "Right second", box: [600, 125, 800, 145] },
    ];
    expect(() => validateLineOrder(rows, [[1], [2], [3], [4]])).toThrow("interleaves");
    expect(validateLineOrder(rows, [[1, 3], [2, 4]])).toHaveLength(2);
  });
});

it("rejects metadata before a verse continuation but allows it between songs", async () => {
  const { validateSemanticOrder } = await import("./ocr-line-order.ts");
  expect(() => validateSemanticOrder([{ section: 0, kind: "verse" }, { section: 0, kind: "metadata" }, { section: 0, kind: "verse" }])).toThrow("interrupts verse");
  expect(() => validateSemanticOrder([{ section: 0, kind: "verse" }, { section: 0, kind: "metadata" }, { section: 1, kind: "verse" }])).not.toThrow();
});
