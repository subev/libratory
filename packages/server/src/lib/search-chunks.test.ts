import { describe, expect, it } from "vitest";
import { chunkPagedText, chunkPlainText, pageMapFromBlocks, type PageBlock } from "./search-chunks.ts";

const para = (n: number, word = "word") => `${word} `.repeat(n).trim();

describe("chunkPagedText", () => {
  it("maps chunks to pages via form feeds", () => {
    const text = `${para(30, "alpha")}\f${para(30, "beta")}\f${para(30, "gamma")}`;
    const chunks = chunkPagedText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const first = chunks[0];
    expect(first?.pageStart).toBe(1);
    const last = chunks[chunks.length - 1];
    expect(last?.pageEnd).toBe(3);
  });

  it("assigns the right page to a chunk that starts after a form feed", () => {
    const page1 = para(250, "one");
    const page2 = para(250, "two");
    const text = `${page1}\f${page2}`;
    const chunks = chunkPagedText(text);
    const page2Chunk = chunks.find((c) => c.text.startsWith("two"));
    expect(page2Chunk).toBeDefined();
    expect(page2Chunk!.pageStart).toBe(2);
  });

  it("returns null pages when the text has no form feeds", () => {
    const chunks = chunkPagedText(para(100));
    expect(chunks[0]?.pageStart).toBeNull();
    expect(chunks[0]?.pageEnd).toBeNull();
  });

  it("keeps offsets true: slicing the source at chunk offsets reproduces the text", () => {
    const text = `${para(300, "first")}\n\n${para(300, "second")}\f${para(300, "third")}`;
    for (const chunk of chunkPagedText(text)) {
      expect(text.slice(chunk.charStart, chunk.charEnd).replace(/\f/g, "\n")).toBe(chunk.text);
    }
  });

  it("overlaps consecutive chunks so lead-in context is kept", () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} says something. `).join("");
    const chunks = chunkPagedText(sentences);
    expect(chunks.length).toBeGreaterThan(1);
    let overlapping = 0;
    for (const [i, chunk] of chunks.entries()) {
      const previous = chunks[i - 1];
      if (previous && chunk.charStart < previous.charEnd) overlapping++;
    }
    expect(overlapping).toBeGreaterThan(0);
  });

  it("splits paragraphs larger than the target size", () => {
    const long = "This is a sentence. ".repeat(300).trim();
    const chunks = chunkPagedText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1400 + 300);
    }
  });

  it("drops whitespace-only content", () => {
    expect(chunkPagedText("\n\n \f  \n\n")).toEqual([]);
  });
});

describe("chunkPlainText", () => {
  it("applies the given page range to every chunk", () => {
    const chunks = chunkPlainText(`${para(300)}\n\n${para(300)}`, 5, 9);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.pageStart).toBe(5);
      expect(chunk.pageEnd).toBe(9);
    }
  });

  it("defaults pages to null", () => {
    const [chunk] = chunkPlainText(para(20));
    expect(chunk?.pageStart).toBeNull();
    expect(chunk?.pageEnd).toBeNull();
  });

  it("uses the offset→page map over the static range when given", () => {
    const p1 = para(300, "alpha");
    const p2 = para(300, "beta");
    const text = `${p1}\n\n${p2}`;
    const pageOf = (offset: number) => (offset < p1.length ? 10 : 11);
    const chunks = chunkPlainText(text, 5, 9, pageOf);
    const betaChunk = chunks.find((c) => c.text.startsWith("beta"));
    expect(chunks[0]?.pageStart).toBe(10);
    expect(betaChunk!.pageStart).toBe(11);
  });
});

describe("pageMapFromBlocks", () => {
  const block = (page: number, text: string, included = true): PageBlock => ({ page, text, included });

  it("maps offsets to the page of the preceding block", () => {
    const a = para(50, "alpha");
    const b = para(50, "beta");
    const c = para(50, "gamma");
    const text = [a, b, c].join("\n\n");
    const pageOf = pageMapFromBlocks(text, [block(129, a), block(130, b), block(131, c)])!;
    expect(pageOf(0)).toBe(129);
    expect(pageOf(text.indexOf("beta"))).toBe(130);
    expect(pageOf(text.length - 1)).toBe(131);
  });

  it("skips excluded and unmatched blocks", () => {
    const a = para(50, "alpha");
    const b = para(50, "beta");
    const text = [a, b].join("\n\n");
    const pageOf = pageMapFromBlocks(text, [
      block(1, "header not in text", false),
      block(2, a),
      block(3, "cleaned away entirely"),
      block(4, b),
    ])!;
    expect(pageOf(0)).toBe(2);
    expect(pageOf(text.indexOf("beta"))).toBe(4);
  });

  it("returns null when no block matches", () => {
    expect(pageMapFromBlocks(para(50), [block(1, "nothing here")])).toBeNull();
  });
});
