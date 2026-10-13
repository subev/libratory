import { describe, expect, it } from "vitest";

import { blockBox, closingMarks, isTitleLike, locateSavedChapter, locateSavedChapters } from "./chapter-anchors.ts";

describe("isTitleLike", () => {
  it("accepts a short line in capitals, in any script", () => {
    expect(isTitleLike("THE TALE OF THE FLOPSY BUNNIES")).toBe(true);
    expect(isTitleLike("ГЛАВА ПЪРВА")).toBe(true);
  });

  it("rejects prose, long lines and lines without enough letters", () => {
    expect(isTitleLike("It is said that the effect of eating too much lettuce is soporific.")).toBe(false);
    expect(isTitleLike("THE TALE OF THE FLOPSY BUNNIES AND THE REST OF THE FAMILY")).toBe(false);
    expect(isTitleLike("1902")).toBe(false);
    expect(isTitleLike("The Tale")).toBe(false);
  });
});

describe("locateSavedChapter", () => {
  const blocks = [
    { text: "Front", page: 1 },
    { text: "Chapter 1", page: 2 },
    { text: "one", page: 2 },
    { text: "Chapter 2", page: 3 },
    { text: "two", page: 3 },
  ];

  it("finds the run of blocks a chapter was cut from", () => {
    expect(locateSavedChapter(blocks, blocks.slice(1, 3))).toEqual({ start: 1, end: 3 });
    expect(locateSavedChapter(blocks, blocks.slice(3))).toEqual({ start: 3, end: 5 });
  });

  it("ignores whitespace, which extraction has changed between releases", () => {
    const stored = [{ text: "Chapter  1", page: 2 }, { text: "o ne", page: 2 }];
    expect(locateSavedChapter(blocks, stored)).toEqual({ start: 1, end: 3 });
  });

  it("treats a block newly left out or taken in as a different chapter", () => {
    const current = [{ text: "One", page: 1, included: true }, { text: "Body", page: 1, included: false }];
    expect(locateSavedChapter(current, [{ text: "One", page: 1, included: true }, { text: "Body", page: 1, included: true }])).toBeNull();
    expect(locateSavedChapter(current, [{ text: "One", page: 1, included: true }, { text: "Body", page: 1, included: false }])).toEqual({ start: 0, end: 2 });
    expect(locateSavedChapter(current.map((b) => ({ ...b, included: true })), current)).toBeNull();
  });

  it("returns null when the sequence is gone or the page moved", () => {
    expect(locateSavedChapter(blocks, [{ text: "Chapter 1", page: 2 }, { text: "two", page: 3 }])).toBeNull();
    expect(locateSavedChapter(blocks, [{ text: "one", page: 9 }])).toBeNull();
    expect(locateSavedChapter(blocks, [])).toBeNull();
  });
});

describe("locateSavedChapters", () => {
  it("gives a repeated passage to each saved chapter in turn", () => {
    const refrain = [{ text: "A refrain", page: 1 }, { text: "Repeat me", page: 1 }];
    const blocks = [...refrain, ...refrain, { text: "Coda", page: 2 }];
    expect(locateSavedChapters(blocks, [refrain, refrain, [{ text: "Coda", page: 2 }]])).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  it("searches from the top again for a chapter that is not after the previous one", () => {
    const blocks = [{ text: "Front", page: 1 }, { text: "Chapter 1", page: 2 }, { text: "Chapter 2", page: 3 }];
    expect(locateSavedChapters(blocks, [[{ text: "Chapter 2", page: 3 }], [{ text: "Chapter 1", page: 2 }], [{ text: "gone", page: 9 }]])).toEqual([
      { start: 2, end: 3 },
      { start: 1, end: 2 },
      null,
    ]);
  });
});

describe("blockBox", () => {
  it("normalises a polygon to ten-thousandths of the page, clamped", () => {
    const page = { w: 500, h: 800 };
    expect(blockBox([[50, 80], [450, 80], [450, 160], [50, 160]], page)).toEqual([1000, 1000, 8000, 1000]);
    expect(blockBox([[-10, 0], [600, 900]], page)).toEqual([0, 0, 10000, 10000]);
  });

  it("is null without a polygon or a page size", () => {
    expect(blockBox(undefined, { w: 500, h: 800 })).toBeNull();
    expect(blockBox([], { w: 500, h: 800 })).toBeNull();
    expect(blockBox([[1, 1]], undefined)).toBeNull();
  });
});

describe("closingMarks", () => {
  const text = (t: string, page: number, type = "Text") => ({ text: t, page, included: true, type });

  it("marks a capitals line that ends a page under other text, never one that opens a page or sits between text", () => {
    const blocks = [
      text("THE TALE OF PETER RABBIT", 1),
      text("Once upon a time there were four little rabbits.", 1),
      text("THE END", 1),
      text("They lived under a fir tree.", 2),
      text("THE TALE OF BENJAMIN BUNNY", 2),
      text("One morning a little rabbit sat on a bank.", 2),
      text("CHAPTER ONE", 3, "SectionHeader"),
    ];
    expect(closingMarks(blocks)).toEqual([false, false, true, false, false, false, false]);
  });

  it("cannot tell a closing mark from a title that ends its page: both are only demoted", () => {
    // A caption, then the title, with the story on the next page — the same shape as THE END
    const blocks = [text("Peter and his mother", 4), text("THE TALE OF PETER RABBIT", 4), text("Once upon a time.", 5)];
    expect(closingMarks(blocks)).toEqual([false, true, false]);
    expect(closingMarks([text("THE FLOPSY BUNNIES", 5)])).toEqual([false]);
  });
});
