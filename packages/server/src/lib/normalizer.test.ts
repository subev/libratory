import { describe, expect, it } from "vitest";
import { normalizeBlocks, normalizeForTts } from "./normalizer.ts";

describe("normalizeForTts", () => {
  it("strips markdown bold and italic", () => {
    expect(normalizeForTts("This is **bold** and *italic* text")).toBe(
      "This is bold and italic text",
    );
  });

  it("strips markdown links, keeping the text", () => {
    expect(normalizeForTts("Visit [Google](https://google.com) now")).toBe(
      "Visit Google now",
    );
  });

  it("removes markdown images entirely", () => {
    expect(normalizeForTts("Before ![alt](img.png) after")).toBe(
      "Before after",
    );
  });

  it("removes reference markers like [1] and [iv]", () => {
    expect(normalizeForTts("Some claim [1] and another [iv] here")).toBe(
      "Some claim and another here",
    );
  });

  it("removes bare URLs", () => {
    expect(normalizeForTts("See https://example.com/foo for details")).toBe(
      "See for details",
    );
  });

  it("takes the bracket a book wraps a URL in with the URL", () => {
    expect(normalizeForTts("a predicate such as <http://my.com/ns#within> or WITHIN")).toBe(
      "a predicate such as or WITHIN",
    );
  });

  it("leaves the underscores inside an identifier alone", () => {
    expect(normalizeForTts("just WITHIN or LIVES_IN, not lives_in either")).toBe(
      "just WITHIN or LIVES_IN, not lives_in either",
    );
  });

  it("rejoins hyphenated line breaks", () => {
    expect(normalizeForTts("con-\ntinue")).toBe("continue");
  });

  it("collapses multiple blank lines", () => {
    expect(normalizeForTts("A\n\n\n\n\nB")).toBe("A\n\nB");
  });

  it("handles a realistic paragraph with mixed markdown", () => {
    const input = `## Chapter One

This is a **bold** claim [1]. See [details](https://example.com) for more info.

![figure](fig1.png)

The con-
clusion is *important*.`;

    const result = normalizeForTts(input);
    expect(result).not.toContain("##");
    expect(result).not.toContain("**");
    expect(result).not.toContain("[1]");
    expect(result).not.toContain("https://");
    expect(result).not.toContain("![");
    expect(result).toContain("conclusion");
    expect(result).toContain("bold claim");
  });
});

describe("normalizeBlocks", () => {
  const blocks = [
    { text: "## Chapter One", included: true },
    { text: "A page header", included: false },
    { text: "This is a **bold** claim [1].", included: true },
    { text: "https://example.com", included: true },
    { text: "The con-\nclusion is *important*.", included: true },
  ];

  it("produces exactly what normalizing the joined chapter produces", () => {
    const rawText = blocks.filter((b) => b.included).map((b) => b.text).join("\n\n");

    expect(normalizeBlocks(blocks).text).toBe(normalizeForTts(rawText));
  });

  it("maps every surviving block to its own range of the result", () => {
    const { text, spans } = normalizeBlocks(blocks);

    expect(spans.map((span) => span.block)).toEqual([0, 2, 4]);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "Chapter One",
      "This is a bold claim .",
      "The conclusion is important.",
    ]);
  });
});
