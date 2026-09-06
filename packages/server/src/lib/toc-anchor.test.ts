import { describe, expect, it } from "vitest";

import { buildPageMap, findAnchors, locateEntries, titleSimilarity, type HeadingCatalogEntry } from "./toc-anchor.ts";

function heading(blockIndex: number, text: string, page: number, words = 500): HeadingCatalogEntry {
  return { id: `h_${String(blockIndex).padStart(4, "0")}`, blockIndex, page, level: 1, text, words };
}

describe("titleSimilarity", () => {
  it("is the share of the printed title's words found in the heading", () => {
    expect(titleSimilarity("The Carrot or the Stick: Motivation Direction", "The Carrot or the Stick:  Motivation Direction")).toBe(1);
    expect(titleSimilarity("Where Do You Know That?", "Wfiere rnO :YOU 1(now %at?")).toBeLessThan(0.5);
  });

  it("keeps chapter numbers apart and penalizes headings far longer than the title", () => {
    expect(titleSimilarity("Chapter 1", "Chapter 1")).toBe(1);
    expect(titleSimilarity("Chapter 1", "Chapter 2")).toBe(0.5);
    expect(titleSimilarity("Sales and Marketing", "Sales and marketing people who use the profile in the field every day")).toBeLessThan(0.75);
  });

  it("matches one-word titles only against short headings", () => {
    expect(titleSimilarity("Self", "Self")).toBe(1);
    expect(titleSimilarity("Self", "Self, other and the world at large")).toBe(0);
  });
});

describe("buildPageMap", () => {
  it("returns null with too few anchors", () => {
    expect(buildPageMap([{ printed: 1, pdf: 6 }, { printed: 9, pdf: 14 }])).toBeNull();
  });

  it("follows a drifting offset and ignores a title matched far away", () => {
    const map = buildPageMap([
      { printed: 3, pdf: 8 },
      { printed: 15, pdf: 20 },
      { printed: 19, pdf: 171 },
      { printed: 45, pdf: 50 },
      { printed: 89, pdf: 92 },
      { printed: 97, pdf: 100 },
      { printed: 145, pdf: 145 },
    ]);
    expect(map?.anchors).toHaveLength(6);
    expect(map?.expected(48)).toBe(53);
    expect(map?.expected(92)).toBe(95);
    expect(map?.expected(150)).toBe(150);
    expect(map?.summary).toBe("+5 (p3–45), +3 (p89–97), 0 (p145+)");
    const drifting = buildPageMap([3, 15, 29, 45, 60, 96, 123, 124, 129, 133, 145, 155].map((printed, i) => ({ printed, pdf: printed + Math.max(0, 6 - i) })));
    expect(drifting?.summary).toBe("+6 at p3 drifting to 0 at p123");
  });

  it("summarizes a constant offset as one number", () => {
    const map = buildPageMap([{ printed: 1, pdf: 4 }, { printed: 10, pdf: 13 }, { printed: 30, pdf: 33 }]);
    expect(map?.summary).toBe("+3");
  });
});

describe("findAnchors", () => {
  const catalog = [heading(1, "Introduction", 12), heading(5, "Motivation Traits", 20), heading(9, "Motivation Traits", 181), heading(12, "Golden Handshakes", 26)];

  it("anchors entries whose title matches one heading clearly", () => {
    expect(findAnchors([{ title: "Golden Handshakes", page: 20, level: 1 }], catalog)).toEqual([{ printed: 20, pdf: 26 }]);
  });

  it("skips one-word titles and titles that match several headings", () => {
    expect(findAnchors([{ title: "Introduction", page: 3, level: 1 }, { title: "Motivation Traits", page: 13, level: 1 }], catalog)).toEqual([]);
  });
});

describe("locateEntries", () => {
  const catalog = [
    heading(10, "Chapter 1", 5),
    heading(20, "Chapter 2", 9),
    heading(30, "Chapter 3", 13),
    heading(35, "Pattern Recognition", 16, 12),
    heading(40, "Cliapter Fuor", 17),
    heading(50, "Chapter 5", 21),
  ];
  const pageMap = buildPageMap([{ printed: 3, pdf: 5 }, { printed: 7, pdf: 9 }, { printed: 11, pdf: 13 }])!;

  it("places entries whose heading is unambiguous near the expected page", () => {
    const { located, unresolved } = locateEntries(
      [{ index: 0, titles: ["Chapter 1", "Chapter One"], page: 3 }, { index: 1, titles: ["Chapter 2"], page: 7 }],
      catalog,
      pageMap
    );
    expect(located).toEqual([{ entry: 0, blockIndex: 10 }, { entry: 1, blockIndex: 20 }]);
    expect(unresolved).toEqual([]);
  });

  it("hands back garbled entries with the headings near the expected page", () => {
    const { located, unresolved } = locateEntries([{ index: 3, titles: ["Chapter 4", "Chapter Four"], page: 15 }], catalog, pageMap);
    expect(located).toEqual([]);
    expect(unresolved).toEqual([{ entry: 3, expectedPage: 17, candidates: [catalog[2], catalog[3], catalog[4], catalog[5]] }]);
  });

  it("searches wider before the first anchor, where front matter numbering breaks the offset", () => {
    const front = [heading(2, "Contents", 1), heading(4, "Acknowledgments", 3), heading(6, "Introduction", 7), ...catalog];
    const { located } = locateEntries([{ index: 0, titles: ["Introduction"], page: 1 }], front, pageMap);
    expect(located).toEqual([{ entry: 0, blockIndex: 6 }]);
    expect(pageMap.anchored(1)).toBe(false);
    expect(pageMap.anchored(7)).toBe(true);
  });

  it("never places a chapter before the previous one", () => {
    const { located, unresolved } = locateEntries(
      [{ index: 0, titles: ["Chapter 3"], page: 11 }, { index: 1, titles: ["Chapter 1"], page: 3 }],
      catalog,
      pageMap
    );
    expect(located).toEqual([{ entry: 0, blockIndex: 30 }]);
    expect(unresolved[0]?.entry).toBe(1);
  });

  it("matches by title alone without a page map and offers similar headings otherwise", () => {
    const { located, unresolved } = locateEntries(
      [{ index: 0, titles: ["Chapter 2"], page: null }, { index: 1, titles: ["Chapter Four"], page: null }],
      catalog,
      null
    );
    expect(located).toEqual([{ entry: 0, blockIndex: 20 }]);
    expect(unresolved[0]?.candidates.map((h) => h.blockIndex)).toEqual([30, 50]);
  });
});
