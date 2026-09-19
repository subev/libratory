import { describe, expect, it } from "vitest";

import { buildText, chapterLink, chapterMode, printMarks } from "./reader-doc.ts";
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
