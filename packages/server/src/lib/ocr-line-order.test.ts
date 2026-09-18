import { describe, expect, it } from "vitest";
import { orderedTranscription, splitOrderedColumns, validateLineOrder, type OcrLine } from "./ocr-line-order.ts";
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

it("allows prose after source notes to introduce a new quoted verse passage", async () => {
  const { validateSemanticOrder } = await import("./ocr-line-order.ts");
  const groups = [
    { section: 0, kind: "verse" as const, breakBefore: "paragraph" as const },
    { section: 0, kind: "metadata" as const, breakBefore: "paragraph" as const },
    { section: 0, kind: "prose" as const, breakBefore: "paragraph" as const },
  ];
  expect(() => validateSemanticOrder([...groups, { section: 0, kind: "verse", breakBefore: "paragraph" }])).not.toThrow();
  expect(() => validateSemanticOrder([...groups, { section: 0, kind: "verse", breakBefore: "line" }])).toThrow("interrupts verse");
});

it("normalizes inapplicable line boundaries without changing semantic order", async () => {
  const { validateSemanticOrder } = await import("./ocr-line-order.ts");
  for (const kind of ["heading", "prose"] as const) {
    const groups = [
      { section: 0, kind, breakBefore: "paragraph" as const },
      { section: 0, kind: "verse" as const, breakBefore: "line" as const },
      { section: 0, kind: "verse" as const, breakBefore: "line" as const },
      { section: 0, kind: "verse" as const, breakBefore: "stanza" as const },
    ];
    expect(validateSemanticOrder(groups).map((g) => g.breakBefore)).toEqual(["paragraph", "paragraph", "line", "stanza"]);
    expect(groups[1]?.breakBefore).toBe("line");
  }
  expect(validateSemanticOrder([{ section: 0, kind: "verse", breakBefore: "line" }])[0]?.breakBefore).toBe("paragraph");
  expect(validateSemanticOrder([{ section: 0, kind: "verse" }, { section: 1, kind: "verse", breakBefore: "line" }])[1]?.breakBefore).toBe("paragraph");
  expect(validateSemanticOrder([{ section: 0, kind: "heading", breakBefore: "line" }, { section: 0, kind: "metadata", breakBefore: "line" }]).map((g) => g.breakBefore)).toEqual(["paragraph", "paragraph"]);
  expect(() => validateSemanticOrder([{ section: 1, kind: "verse" }, { section: 0, kind: "verse" }])).toThrow("earlier section");
  expect(() => validateSemanticOrder([{ section: 0, kind: "metadata" }, { section: 0, kind: "verse", breakBefore: "line" }])).toThrow();
});

it("accepts an empty detection only when its transcription and every OCR label are empty", () => {
  const blank = { id: 1, text: "", box: [10, 10, 20, 20] as [number, number, number, number] };
  expect(orderedTranscription([[blank]], [{ group: 0, type: "other", text: "" }]).lineGroups).toEqual([[blank]]);
  expect(() => orderedTranscription([[blank, { ...blank, id: 2, text: "Real words" }]], [{ group: 0, type: "other", text: "" }])).toThrow("group 0 with recognized text");
  expect(orderedTranscription([[blank]], [{ group: 0, type: "other", text: "Text missed by OCR" }]).blocks[0]?.text).toBe("Text missed by OCR");
});

it("splits a correctly sequenced verse or metadata group at a measured column boundary", () => {
  const input: OcrLine[] = [
    { id: 1, text: "Left first", box: [50, 100, 200, 120] },
    { id: 2, text: "Right first", box: [600, 100, 800, 120] },
    { id: 3, text: "Left second", box: [50, 125, 200, 145] },
    { id: 4, text: "Right second", box: [600, 125, 800, 145] },
  ];
  for (const kind of ["verse", "metadata"] as const) {
    const group = { section: 0, kind, breakBefore: "paragraph" as const, lineIds: [1, 3, 2, 4] };
    const split = splitOrderedColumns(input, [group]);
    expect(split.map((g) => g.lineIds)).toEqual([[1, 3], [2, 4]]);
    expect(split[1]?.breakBefore).toBe(kind === "verse" ? "line" : "paragraph");
    expect(group.lineIds).toEqual([1, 3, 2, 4]);
    if (kind === "verse") {
      expect(() => splitOrderedColumns(input, [{ ...group, lineIds: [1, 2, 3, 4] }])).toThrow("returns to the left");
      expect(() => splitOrderedColumns(input, [{ ...group, lineIds: [2, 4, 1, 3] }])).toThrow("returns to the left");
    } else {
      for (const lineIds of [[1, 2, 3, 4], [2, 4, 1, 3]]) {
        expect(splitOrderedColumns(input, [{ ...group, lineIds }]).map((g) => g.lineIds)).toEqual([[1, 3], [2, 4]]);
      }
    }
    expect(() => validateLineOrder(input, splitOrderedColumns(input, [{ ...group, lineIds: [1, 3, 2] }]).map((g) => g.lineIds))).toThrow("omitted");
    expect(() => validateLineOrder(input, splitOrderedColumns(input, [{ ...group, lineIds: [1, 3, 2, 2, 4] }]).map((g) => g.lineIds))).toThrow("repeats");
  }
});

it("does not repartition metadata across a line spanning the proposed column gap", () => {
  const input: OcrLine[] = [
    { id: 1, text: "Date", box: [50, 100, 200, 120] },
    { id: 2, text: "Contributor", box: [600, 100, 800, 120] },
    { id: 3, text: "Spanning note", box: [50, 125, 800, 145] },
  ];
  expect(() => splitOrderedColumns(input, [{ section: 0, kind: "metadata", breakBefore: "paragraph", lineIds: [2, 1, 3] }])).toThrow("returns to the left");
});

it("repairs interleaved verse columns only when printed counters prove every line distance", async () => {
  const { restoreCounterColumnOrder } = await import("./verse-order.ts");
  const left = Array.from({ length: 10 }, (_, i): OcrLine => ({ id: i * 2 + 1,
    text: `${i % 5 === 0 ? `${i + 20} ` : ""}Left verse`, box: [50, 100 + i * 25, 250, 120 + i * 25] }));
  const right = left.map((line, i): OcrLine => ({ id: line.id + 1,
    text: `${i % 5 === 0 ? `${i + 30} ` : ""}Right verse`, box: [600, 100 + i * 25, 800, 120 + i * 25] }));
  const lines = [...left, ...right];
  const group = { kind: "verse" as const, section: 0, breakBefore: "paragraph" as const,
    lineIds: Array.from({ length: 20 }, (_, i) => i + 1) };
  const restored = restoreCounterColumnOrder(lines, [group]);
  expect(restored[0]?.lineIds).toEqual(lines.map((line) => line.id));
  expect(validateLineOrder(lines, splitOrderedColumns(lines, restored).map((item) => item.lineIds))).toHaveLength(2);
  expect(group.lineIds[1]).toBe(2);
  const contradictory = lines.map((line) => line.id === 2 ? { ...line, text: "40 Right verse" } : line);
  expect(restoreCounterColumnOrder(contradictory, [group])).toEqual([group]);
  expect(restoreCounterColumnOrder(lines, [{ ...group, lineIds: group.lineIds.filter((id) => id !== 3) }])[0]?.lineIds)
    .toEqual(group.lineIds.filter((id) => id !== 3));
  expect(restoreCounterColumnOrder(lines, [{ ...group, kind: "prose" }])[0]?.lineIds).toEqual(group.lineIds);
});


it("keeps page furniture outside section sequencing and starts fresh after a heading", async () => {
  const { validateSemanticOrder } = await import("./ocr-line-order.ts");
  const groups = [
    { section: 0, kind: "metadata" as const },
    { section: 0, kind: "heading" as const },
    { section: 0, kind: "verse" as const },
    { section: 1, kind: "heading" as const },
    { section: 1, kind: "verse" as const },
    { section: 0, kind: "furniture" as const },
  ];
  expect(validateSemanticOrder(groups)).toEqual(groups);
  expect(() => validateSemanticOrder([...groups, { section: 0, kind: "verse" }])).toThrow("earlier section");
  expect(() => validateSemanticOrder([{ section: 0, kind: "metadata" },
    { section: 0, kind: "furniture" }, { section: 0, kind: "verse" }])).toThrow("interrupts verse");
});

it("keeps a tiny scan-edge detection without treating it as a verse column", () => {
  const input: OcrLine[] = [
    { id: 1, text: "Verse above", box: [550, 200, 810, 220] },
    { id: 2, text: "ı", box: [985, 200, 997, 220] },
    { id: 3, text: "Verse below", box: [550, 225, 810, 245] },
  ];
  const split = splitOrderedColumns(input, [{ section: 0, kind: "verse", breakBefore: "line", lineIds: [1, 2, 3] }]);
  expect(split.map((group) => [group.kind, group.lineIds])).toEqual([["verse", [1, 3]], ["furniture", [2]]]);
  const groups = validateLineOrder(input, split.map((group) => group.lineIds));
  expect(orderedTranscription(groups, [{ group: 0, type: "paragraph", text: "Verse above\nVerse below" },
    { group: 1, type: "other", text: "" }]).lineGroups?.flat()).toHaveLength(3);
  const bodyLetter: OcrLine = { id: 4, text: "I", box: [100, 100, 112, 120] };
  expect(() => orderedTranscription([[bodyLetter]], [{ group: 0, type: "paragraph", text: "" }])).toThrow("recognized text");
  const edgeWord: OcrLine = { id: 5, text: "Word", box: [975, 100, 997, 120] };
  expect(() => orderedTranscription([[edgeWord]], [{ group: 0, type: "paragraph", text: "" }])).toThrow("recognized text");
});
