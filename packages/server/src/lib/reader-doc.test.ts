import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildText, buildVariantCues, chapterLink, chapterMode, placeCues, printMarks } from "./reader-doc.ts";
import type { RectContext } from "./cue-rects.ts";
import { alignTexts } from "./text-alignment.ts";
import type { GeometryLine, GeometryPage } from "./page-geometry.ts";
import { writeSyncMap } from "./sync-map.ts";
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

  it("says the text was edited when an override replaced it, or when there is nothing to line it up with", () => {
    expect(chapterMode(extracted({ cleanText: "A line of print.", customText: "Rewritten by hand, so the print says something else." })))
      .toEqual({ mode: "text", why: "edited" });
    expect(chapterMode(extracted({ cleanText: null, customText: "A line of print." }))).toEqual({ mode: "text", why: "edited" });
  });

  it("keeps a corrected chapter on its pages and says how much of it the print holds", () => {
    expect(chapterMode(extracted({ cleanText: "A 1ine of print, said the scanner.", customText: "A line of print, said the scanner." })))
      .toEqual({ mode: "page", fit: 0.86 });
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

  it("says nothing at all when the geometry never built", () => {
    expect(printMarks(null, { pageStart: 1, pageEnd: 2 })).toBeUndefined();
  });

  it("says nothing about a chapter that never landed on a page", () => {
    expect(printMarks([printed(0)], { pageStart: null, pageEnd: null })).toBeUndefined();
  });
});

it("carries semantic blocks and normalized offsets to the reader, but drops stale structure for edited text", async () => {
  const { buildText } = await import("./reader-doc.ts");
  const { normalizeChapter } = await import("../workers/normalize.ts");
  const sourceBlocks = [
    { type: "Text", kind: "verse" as const, text: "Left verse", page: 1, included: true },
    { type: "Text", kind: "verse" as const, breakBefore: "line" as const, text: "Right verse", page: 1, included: true },
    { type: "Text", kind: "footnote" as const, text: "14 **Note**.", page: 1, included: true },
  ];
  const rawText = "Left verse\nRight verse\n\n14 **Note**.";
  const normalized = normalizeChapter(rawText, sourceBlocks);
  expect(normalized.textMap?.spans).toHaveLength(3);
  const chapter = extracted({ rawText, sourceBlocks, ...normalized, customText: null });
  const document = buildText(chapter);
  expect(document?.text).toBe("Left verse\nRight verse\n\n14 Note.");
  expect(document?.blocks?.map((b) => [b.kind, document.text.slice(b.start, b.end)])).toEqual([["verse", "Left verse"], ["verse", "Right verse"], ["footnote", "14 Note."]]);
  expect(buildText({ ...chapter, customText: "Edited." })?.blocks).toBeUndefined();
  expect(buildText({ ...chapter, cleanText: "Changed." })?.blocks).toBeUndefined();
});

it("carries typed blocks across an edit, with what was typed in falling into the block before it", async () => {
  const { buildText } = await import("./reader-doc.ts");
  const { normalizeChapter } = await import("../workers/normalize.ts");
  const sourceBlocks = [
    { type: "Text", kind: "heading" as const, text: "CHAPTER 1", page: 1, included: true },
    { type: "Text", kind: "prose" as const, text: "A frist paragraph of the chapter.", page: 1, included: true },
    { type: "Text", kind: "footnote" as const, text: "1 A note.", page: 1, included: true },
  ];
  const rawText = "CHAPTER 1\n\nA frist paragraph of the chapter.\n\n1 A note.";
  const normalized = normalizeChapter(rawText, sourceBlocks);
  const kinds = (customText: string) => {
    const document = buildText(extracted({ rawText, sourceBlocks, ...normalized, customText }));
    return document?.blocks?.map((b) => [b.kind, document.text.slice(b.start, b.end)]);
  };
  expect(kinds("CHAPTER 1\n\nA first paragraph of the chapter.\n\nA second one, typed in.\n\n1 A note.")).toEqual([
    ["heading", "CHAPTER 1"],
    ["prose", "A first paragraph of the chapter."],
    ["prose", "A second one, typed in."],
    ["footnote", "1 A note."],
  ]);
  // A paragraph typed in beside a heading or a footnote, or ahead of everything, is prose; words
  // typed onto the same paragraph as a block belong to it
  expect(kinds("Before.\n\nCHAPTER 1, continued\n\nIntro.\n\nA frist paragraph of the chapter.\n\n1 A note.\n\nAfter.")).toEqual([
    ["prose", "Before."],
    ["heading", "CHAPTER 1, continued"],
    ["prose", "Intro."],
    ["prose", "A frist paragraph of the chapter."],
    ["footnote", "1 A note."],
    ["prose", "After."],
  ]);
});

it("drops a block whose only word the edit joined onto the next block's", async () => {
  const { buildText } = await import("./reader-doc.ts");
  const { normalizeChapter } = await import("../workers/normalize.ts");
  const sourceBlocks = [
    { type: "Text", kind: "heading" as const, text: "Pon-", page: 1, included: true },
    { type: "Text", kind: "prose" as const, text: "dered, weak and weary, over many a quaint and curious volume.", page: 1, included: true },
  ];
  const rawText = "Pon-\n\ndered, weak and weary, over many a quaint and curious volume.";
  const normalized = normalizeChapter(rawText, sourceBlocks);
  const customText = "Pondered, weak and weary, over many a quaint and curious volume.";
  const document = buildText(extracted({ rawText, sourceBlocks, ...normalized, customText }));
  expect(document?.blocks?.map((b) => [b.kind, document.text.slice(b.start, b.end)])).toEqual([
    ["prose", "Pondered, weak and weary, over many a quaint and curious volume."],
  ]);
});

// A monospaced page: x reads straight off the character index, lines are 10 apart
const CHAR = 5;
function line(text: string, top: number): GeometryLine {
  return { b: [50, top, 50 + text.length * CHAR, top + 10], t: text, xs: Array.from({ length: text.length + 1 }, (_, i) => 50 + i * CHAR) };
}

function printedContext(cleanText: string, lines: GeometryLine[]): RectContext {
  return {
    cleanText,
    textMap: { version: 1, spans: [{ block: 0, start: 0, end: cleanText.length }] },
    blocks: [{ type: "Text", text: cleanText, page: 1, included: true, polygon: [[40, 90], [460, 90], [460, 200], [40, 200]] }],
    page: () => ({ index: 0, geometry: { i: 0, w: 500, h: 1000, rot: 0, cropOffset: [0, 0], lines } }),
  };
}

describe("placeCues", () => {
  const ORIGINAL = "The frist line of the block. The second line follows it.";
  const EDITED = "The first line of the block. The second line follows it.";
  const context = printedContext(ORIGINAL, [line("The frist line of the block.", 100), line("The second line follows it.", 110)]);
  const y = (top: number) => Math.round((top / 1000) * 10_000);
  const x = (column: number) => Math.round(((50 + column * CHAR) / 500) * 10_000);

  it("carries a cue narrated from the corrected text onto the print, word boxes and all", () => {
    const alignment = alignTexts(EDITED, ORIGINAL)!;
    const cues = [
      { text: "The first line of the block.", startMs: 0, endMs: 1000, chunk: 0, words: [
        { text: "The", after: " ", startMs: 0, endMs: 100 }, { text: "first", after: " ", startMs: 100, endMs: 300 },
      ] },
      { text: "The second line follows it.", startMs: 1000, endMs: 2000, chunk: 0 },
    ];
    const [first, second] = placeCues(context, cues, { text: EDITED, alignment });

    expect(first?.rects.map((r) => r[2])).toEqual([y(100)]);
    expect(second?.rects.map((r) => r[2])).toEqual([y(110)]);
    // "first" sits where the print's "frist" is
    expect(first?.words?.[1]?.[0]?.[1]).toBe(x(4));
  });

  it("falls back to the original for a cue narrated before the edit, and places nothing for a sentence typed in", () => {
    const typedIn = EDITED + " A sentence added by hand.";
    const alignment = alignTexts(typedIn, ORIGINAL)!;
    const cues = [
      { text: "The frist line of the block.", startMs: 0, endMs: 1000, chunk: 0 },
      { text: "A sentence added by hand.", startMs: 1000, endMs: 2000, chunk: 0 },
    ];
    const [stale, added] = placeCues(context, cues, { text: typedIn, alignment });

    expect(stale?.rects.map((r) => r[2])).toEqual([y(100)]);
    expect(added?.rects).toEqual([]);
  });
});

describe("buildText", () => {
  const written = "First paragraph,\nstill the first.\n\nSecond one.  \n \n\nThird.";

  it("gives written text a prose block per paragraph, since nobody typed its blocks", () => {
    const doc = buildText(extracted({ sourceBlocks: null, cleanText: written, rawText: written }));
    expect(doc?.blocks?.map((block) => [block.kind, written.slice(block.start, block.end)])).toEqual([
      ["prose", "First paragraph,\nstill the first."],
      ["prose", "Second one."],
      ["prose", "Third."],
    ]);
  });

  it("keeps the paragraphs of written text through an edit, which has no typed blocks to outdate", () => {
    const doc = buildText(extracted({ sourceBlocks: null, customText: "One.\n\nTwo." }));
    expect(doc?.blocks).toEqual([
      { start: 0, end: 4, kind: "prose" },
      { start: 6, end: 10, kind: "prose" },
    ]);
  });
});

describe("chapterLink", () => {
  it("links a chapter written from a page on the web", () => {
    expect(chapterLink(extracted({ source: { kind: "url", url: "https://example.com/post", title: "Post" } })))
      .toBe("https://example.com/post");
  });

  it("hands out nothing that is not the web", () => {
    expect(chapterLink(extracted({ source: { kind: "url", url: "javascript:alert(1)" } }))).toBeUndefined();
    expect(chapterLink(extracted({ source: { kind: "url", url: "file:///etc/passwd" } }))).toBeUndefined();
  });

  it("has nowhere to send a reader for a digest, a note or a bare API chapter", () => {
    expect(chapterLink(extracted({ source: { kind: "book", bookId: "b", title: "A book" } }))).toBeUndefined();
    expect(chapterLink(extracted({ source: { kind: "api" } }))).toBeUndefined();
    expect(chapterLink(extracted({ source: null }))).toBeUndefined();
  });
});

describe("buildVariantCues", () => {
  it("times a translation's narration over its own paragraphs, with nothing placed on the print", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "variant-cues-"));
    try {
      const audioPath = path.join(dir, "ch000.mp3");
      await writeSyncMap(audioPath, {
        version: 1,
        totalMs: 9000,
        chunks: [
          { text: "Имало едно време един крал.", startMs: 0, endMs: 4000 },
          { text: "Той имал три дъщери.", startMs: 4000, endMs: 9000 },
        ],
      });

      const doc = await buildVariantCues(audioPath, "Имало едно време един крал.\n\nТой имал три дъщери.\n");

      expect(doc?.totalMs).toBe(9000);
      expect(doc?.text?.blocks).toEqual([
        { start: 0, end: 27, kind: "prose" },
        { start: 29, end: 49, kind: "prose" },
      ]);
      expect(doc?.cues.map((cue) => cue.range)).toEqual([[0, 27], [29, 49]]);
      expect(doc?.cues.some((cue) => cue.r || cue.wr)).toBe(false);
      expect(doc?.marks).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has nothing to offer a narration whose timings are gone", async () => {
    expect(await buildVariantCues("/nonexistent/ch000.mp3", "Text.")).toBeNull();
  });
});
