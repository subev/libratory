import { describe, expect, it } from "vitest";

import { chapterMode, printMarks } from "./reader-doc.ts";
import type { GeometryPage } from "./page-geometry.ts";
import type { Chapter } from "../schema.ts";

// A page pdftext could read text off, and one it could not — a scan carries no lines at all
const printed = (lines: number): GeometryPage => ({
  i: 0,
  w: 595,
  h: 842,
  rot: 0,
  cropOffset: [0, 0],
  lines: Array.from({ length: lines }, () => ({ b: [0, 0, 100, 12] as [number, number, number, number], t: "print" })),
});

// An extracted chapter that has been through synthesis: blocks from marker, a map from normalize
function extracted(overrides: Partial<Chapter> = {}): Chapter {
  return {
    sourceBlocks: [{ type: "Text", text: "A line of print.", page: 1, included: true, polygon: [] }],
    customText: null,
    textMap: { version: 1, spans: [{ block: 0, start: 0, end: 16 }] },
    audioPath: "/data/output/chapter.m4a",
    ...overrides,
  } as unknown as Chapter;
}

describe("chapterMode", () => {
  it("marks a narrated chapter on its pages", () => {
    expect(chapterMode(extracted())).toEqual({ mode: "page" });
  });

  // The state every extracted chapter is in before synthesis: normalize writes textMap, not marker
  it("says a chapter is simply unnarrated when nothing has spoken it yet", () => {
    expect(chapterMode(extracted({ textMap: null, audioPath: null })))
      .toEqual({ mode: "text", why: "unnarrated" });
  });

  it("distinguishes audio that predates the text map, which narrating again would write", () => {
    expect(chapterMode(extracted({ textMap: null })))
      .toEqual({ mode: "text", why: "unmapped" });
  });

  it("says the text was edited when a chapter carries an override", () => {
    expect(chapterMode(extracted({ customText: "Rewritten." }))).toEqual({ mode: "text", why: "edited" });
  });

  it("says the text was written when a chapter never came off a page", () => {
    expect(chapterMode(extracted({ sourceBlocks: null }))).toEqual({ mode: "text", why: "generated" });
  });
});

describe("printMarks", () => {
  it("marks words where the pages under the chapter carry a text layer", () => {
    expect(printMarks([printed(4), printed(4)], { pageStart: 1, pageEnd: 2 })).toBe("word");
  });

  it("falls back to the paragraph when a scan gives the aligner no lines", () => {
    expect(printMarks([printed(0), printed(0)], { pageStart: 1, pageEnd: 2 })).toBe("paragraph");
  });

  it("reads only the chapter's own pages, not the whole book's", () => {
    expect(printMarks([printed(4), printed(0)], { pageStart: 2, pageEnd: 2 })).toBe("paragraph");
  });

  it("takes a chapter with no end for a single page", () => {
    expect(printMarks([printed(0), printed(4)], { pageStart: 2, pageEnd: null })).toBe("word");
  });
});
