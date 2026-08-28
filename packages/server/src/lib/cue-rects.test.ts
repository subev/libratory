import { describe, expect, it } from "vitest";

import { rectsForRange, type RectContext } from "./cue-rects.ts";
import type { GeometryLine, GeometryPage } from "./page-geometry.ts";
import type { SourceBlock } from "./marker.ts";

const PAGE_WIDTH = 500;
const PAGE_HEIGHT = 1000;
const CHAR_WIDTH = 5;
const LINE_HEIGHT = 10;

// A monospaced line at x=50, so an expected x is readable straight off the character index
function line(text: string, top: number): GeometryLine {
  return {
    b: [50, top, 50 + text.length * CHAR_WIDTH, top + LINE_HEIGHT],
    t: text,
    xs: Array.from({ length: text.length + 1 }, (_, i) => 50 + i * CHAR_WIDTH),
  };
}

function page(lines: GeometryLine[]): GeometryPage {
  return { i: 0, w: PAGE_WIDTH, h: PAGE_HEIGHT, rot: 0, cropOffset: [0, 0], lines };
}

function block(): SourceBlock {
  return { type: "Text", text: "", page: 1, included: true, polygon: [[40, 90], [460, 90], [460, 200], [40, 200]] };
}

function context(text: string, geometry: GeometryPage | null): RectContext {
  return {
    cleanText: text,
    textMap: { version: 1, spans: [{ block: 0, start: 0, end: text.length }] },
    blocks: [block()],
    page: () => ({ index: 7, geometry }),
  };
}

const LINES = ["The first line of the block.", "The second line follows it.", "And a third line ends it."] as const;
const BLOCK_TEXT = LINES.join(" ");

describe("rectsForRange", () => {
  it("trims a rect to the characters inside one line", () => {
    const geometry = page([line(LINES[0], 100)]);
    const start = BLOCK_TEXT.indexOf("first");

    const [rect] = rectsForRange(context(BLOCK_TEXT, geometry), start, start + "first line".length);

    expect(rect?.[0]).toBe(7);
    expect(rect?.[1]).toBe(Math.round(((50 + 4 * CHAR_WIDTH) / PAGE_WIDTH) * 10_000));
    expect(rect?.[3]).toBe(Math.round((("first line".length * CHAR_WIDTH) / PAGE_WIDTH) * 10_000));
    expect(rect?.[2]).toBe(1000);
    expect(rect?.[4]).toBe(100);
  });

  it("gives a rect per line for a range that crosses them", () => {
    const geometry = page(LINES.map((text, i) => line(text, 100 + i * LINE_HEIGHT)));

    const rects = rectsForRange(context(BLOCK_TEXT, geometry), 0, BLOCK_TEXT.length);

    expect(rects).toHaveLength(3);
    expect(rects.map((rect) => rect[2])).toEqual([1000, 1100, 1200]);
  });

  it("collapses a tall range into first line, body, last line", () => {
    const many = Array.from({ length: 8 }, (_, i) => `Line number ${i} of the block.`);
    const geometry = page(many.map((text, i) => line(text, 100 + i * LINE_HEIGHT)));

    const rects = rectsForRange(context(many.join(" "), geometry), 0, many.join(" ").length);

    expect(rects).toHaveLength(3);
    expect(rects[1]?.[2]).toBe(1100);
    expect(rects[1]?.[4]).toBe(600);
  });

  it("falls back to the block box on a scanned page, which has no lines to trim to", () => {
    expect(rectsForRange(context(BLOCK_TEXT, page([])), 0, 10)).toEqual([[7, 800, 900, 8400, 1100]]);
  });

  it("offers no rect at all when the page geometry is missing", () => {
    expect(rectsForRange(context(BLOCK_TEXT, null), 0, 10)).toEqual([]);
  });

  it("falls back to the block box when the text cannot be found on the page", () => {
    const geometry = page([line("Entirely different characters here.", 100)]);

    expect(rectsForRange(context(BLOCK_TEXT, geometry), 0, 10)).toEqual([[7, 800, 900, 8400, 1100]]);
  });

  it("matches across the markdown and hyphenation the block text no longer has", () => {
    const geometry = page([line("a **bold** con-", 100), line("clusion follows.", 110)]);

    const rects = rectsForRange(context("a bold conclusion follows.", geometry), 0, 26);

    expect(rects).toHaveLength(2);
  });

  it("gives nothing rather than the block box when linesOnly is asked for", () => {
    const geometry = page([line("Entirely different characters here.", 100)]);

    expect(rectsForRange(context(BLOCK_TEXT, geometry), 0, 10, { linesOnly: true })).toEqual([]);
  });

  it("places a repeated word at the occurrence it actually is, not the first", () => {
    const repeated = ["the first line has the word.", "the second line has it too.", "and the third line ends."] as const;
    const geometry = page(repeated.map((text, i) => line(text, 100 + i * LINE_HEIGHT)));
    const text = repeated.join(" ");
    // The "the" that opens the third line — five earlier occurrences precede it
    const start = text.lastIndexOf("the ");

    const [rect] = rectsForRange(context(text, geometry), start, start + 3, { linesOnly: true });

    expect(rect?.[2]).toBe(1200);
    expect(rect?.[1]).toBe(Math.round(((50 + repeated[2].indexOf("the") * CHAR_WIDTH) / PAGE_WIDTH) * 10_000));
  });

  it("places a single word inside its line", () => {
    const geometry = page([line(LINES[0], 100)]);
    const start = BLOCK_TEXT.indexOf("block");

    const [rect] = rectsForRange(context(BLOCK_TEXT, geometry), start, start + 5, { linesOnly: true });

    expect(rect?.[1]).toBe(Math.round(((50 + LINES[0].indexOf("block") * CHAR_WIDTH) / PAGE_WIDTH) * 10_000));
    expect(rect?.[3]).toBe(Math.round(((5 * CHAR_WIDTH) / PAGE_WIDTH) * 10_000));
  });
});

