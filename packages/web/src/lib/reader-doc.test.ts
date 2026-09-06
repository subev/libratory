import { describe, expect, it } from "vitest";

import { bodyFit, cueIndexAt, cuesOfChunk, rectInCrop, wordIndexAt, type ReaderCue, type ReaderPage } from "./reader-doc.ts";

const cue = (t: [number, number], c = 0, w?: [number, number, string][]): ReaderCue => ({ t, s: "x", c, ...(w ? { w } : {}) });

describe("rectInCrop", () => {
  const sheet = { i: 9, p: 10, src: 0, w: 842, h: 595, content: [82, 26, 707, 543], columns: [[82, 26, 315, 543], [493, 27, 296, 540]] } as unknown as ReaderPage;
  const rightColumnRect: [number, number, number, number, number] = [9, 6602, 3000, 1970, 300];

  it("keeps a cue only in the column crop that holds it", () => {
    expect(rectInCrop(sheet, sheet.columns[1]!, rightColumnRect)).toBe(true);
    expect(rectInCrop(sheet, sheet.columns[0]!, rightColumnRect)).toBe(false);
    expect(rectInCrop(sheet, [0, 0, sheet.w, sheet.h], rightColumnRect)).toBe(true);
  });
});

describe("bodyFit", () => {
  it("says nothing until the container has been measured", () => {
    expect(bodyFit(11.7, 300, 0)).toBeNull();
  });

  it("reports the rendered size against what is comfortable to read", () => {
    expect(bodyFit(10, 200, 400)).toEqual({ px: 20, percent: 118 });
  });
});

describe("cueIndexAt", () => {
  it("keeps the last cue lit across the gap before the next one starts", () => {
    const cues = [cue([0, 1000]), cue([2000, 3000])];
    expect(cueIndexAt(cues, 1500)).toBe(0);
  });

  it("lights the first cue before its first word, which can start late", () => {
    expect(cueIndexAt([cue([275, 1000])], 0)).toBe(0);
  });
});

describe("wordIndexAt", () => {
  it("marks no word in the silence between two of them", () => {
    expect(wordIndexAt(cue([0, 900], 0, [[0, 300, "a"], [500, 900, "b"]]), 400)).toBe(-1);
  });
});

describe("cuesOfChunk", () => {
  it("gathers every cue cut from one chunk, and none when nothing is hovered", () => {
    const cues = [cue([0, 1], 0), cue([1, 2], 1), cue([2, 3], 1)];
    expect(cuesOfChunk(cues, 1)).toHaveLength(2);
    expect(cuesOfChunk(cues, null)).toHaveLength(0);
  });
});
