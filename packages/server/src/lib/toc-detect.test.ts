import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./llm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm.ts")>()),
  llmChat: vi.fn(),
}));

import { llmChat } from "./llm.ts";
import {
  buildHeadingCatalog,
  buildPageWindow,
  buildSelectionPrompt,
  detectChaptersWithLlm,
  mergePageTexts,
  parseSelectionResponse,
  parseTocResponse,
} from "./toc-detect.ts";
import type { FlatBlock } from "./marker.ts";

const mockChat = vi.mocked(llmChat);
const noopLog = async () => {};

function block(overrides: Partial<FlatBlock>): FlatBlock {
  return { type: "Text", text: "body", hierarchy: null, page: 1, included: true, ...overrides };
}

function heading(text: string, page: number, level = 1): FlatBlock {
  return block({ type: "SectionHeader", text, page, level });
}

describe("buildPageWindow", () => {
  const blocks = Array.from({ length: 40 }, (_, i) => block({ text: `page ${i + 1} text`, page: i + 1 }));

  it("takes the first pages for head and labels them", () => {
    const window = buildPageWindow(blocks, "head", 3);
    expect(window.pages).toEqual([1, 2, 3]);
    expect(window.text).toContain("p1:\npage 1 text");
    expect(window.text).not.toContain("p4:");
  });

  it("takes the last pages for tail", () => {
    const window = buildPageWindow(blocks, "tail", 2);
    expect(window.pages).toEqual([39, 40]);
  });

  it("joins all blocks of a page, including excluded block types", () => {
    const window = buildPageWindow(
      [block({ text: "a", page: 1 }), block({ text: "b", page: 1, included: false })],
      "head"
    );
    expect(window.text).toBe("p1:\na\nb");
  });

  it("caps the total window size but always keeps at least one page", () => {
    const big = Array.from({ length: 20 }, (_, i) => block({ text: "x".repeat(6000), page: i + 1 }));
    const window = buildPageWindow(big, "head", 20);
    expect(window.pages.length).toBeLessThan(20);
    expect(window.pages.length).toBeGreaterThan(0);
  });
});

describe("mergePageTexts", () => {
  it("keeps the longer text per page", () => {
    const entries = [
      { page: 5, text: "marker text that is long enough to win here" },
      { page: 6, text: "TABLE OF CONTENTS." },
    ];
    const layer = new Map([
      [5, "short layer"],
      [6, "TABLE OF CONTENTS. PRELIMINARY 5  I. ORIGIN OF THE JEWS 8"],
    ]);
    const text = mergePageTexts(entries, layer);
    expect(text).toContain("p5:\nmarker text that is long enough to win here");
    expect(text).toContain("p6:\nTABLE OF CONTENTS. PRELIMINARY 5");
  });

  it("uses marker text when the layer is missing", () => {
    const text = mergePageTexts([{ page: 1, text: "only marker" }], new Map());
    expect(text).toBe("p1:\nonly marker");
  });
});

describe("buildHeadingCatalog", () => {
  it("catalogs included SectionHeaders with ids mapping to block indices", () => {
    const blocks = [
      block({ text: "intro para" }),
      heading("Chapter 1", 5),
      block({ type: "PageHeader", text: "running head", included: false }),
      heading("Chapter 2", 9, 2),
    ];
    expect(buildHeadingCatalog(blocks)).toEqual([
      { id: "h_0001", blockIndex: 1, page: 5, level: 1, text: "Chapter 1" },
      { id: "h_0003", blockIndex: 3, page: 9, level: 2, text: "Chapter 2" },
    ]);
  });

  it("skips headings on excluded pages", () => {
    const blocks = [heading("Contents", 3), heading("Chapter 1", 7)];
    const catalog = buildHeadingCatalog(blocks, new Set([3]));
    expect(catalog.map((h) => h.text)).toEqual(["Chapter 1"]);
  });

  it("skips excluded (non-kept) SectionHeaders", () => {
    const blocks = [block({ type: "SectionHeader", text: "ghost", included: false }), heading("Real", 2)];
    expect(buildHeadingCatalog(blocks).map((h) => h.text)).toEqual(["Real"]);
  });
});

describe("parseTocResponse", () => {
  it("parses a valid response", () => {
    const result = parseTocResponse(
      '{"found": true, "tocPages": [8, 9], "entries": [{"title": "Chapter 1", "page": 12}, {"title": "Epilogue", "page": null}]}'
    );
    expect(result).toEqual({
      found: true,
      tocPages: [8, 9],
      entries: [
        { title: "Chapter 1", page: 12 },
        { title: "Epilogue", page: null },
      ],
    });
  });

  it("strips markdown fences", () => {
    const result = parseTocResponse('```json\n{"found": false, "tocPages": [], "entries": []}\n```');
    expect(result).toEqual({ found: false, tocPages: [], entries: [] });
  });

  it("treats found=true with no entries as not found", () => {
    const result = parseTocResponse('{"found": true, "tocPages": [2], "entries": []}');
    expect(result?.found).toBe(false);
  });

  it("drops malformed entries, accepts digit-string pages, nulls roman numerals", () => {
    const result = parseTocResponse(
      '{"found": true, "tocPages": [0, "x", 3], "entries": [{"title": "", "page": 1}, {"title": "Ok", "page": "12"}, {"title": "Preface", "page": "xv"}, "junk"]}'
    );
    expect(result).toEqual({
      found: true,
      tocPages: [3],
      entries: [
        { title: "Ok", page: 12 },
        { title: "Preface", page: null },
      ],
    });
  });

  it("salvages JSON wrapped in prose", () => {
    const result = parseTocResponse(
      'Here is the result:\n{"found": true, "tocPages": [4], "entries": [{"title": "Ch 1", "page": 9}]}\nLet me know!'
    );
    expect(result).toEqual({ found: true, tocPages: [4], entries: [{ title: "Ch 1", page: 9 }] });
  });

  it("returns null for non-JSON", () => {
    expect(parseTocResponse("I could not find a table of contents.")).toBeNull();
  });
});

describe("parseSelectionResponse", () => {
  const catalog = buildHeadingCatalog([heading("One", 1), heading("Two", 2), heading("Three", 3)]);

  it("parses selections with cleaned and translated titles in reading order", () => {
    const response =
      '{"selections": [{"id": "h_0002", "title": "Chapter Three", "translated": "Глава три"}, {"id": "h_0000", "title": "Chapter One"}]}';
    expect(parseSelectionResponse(response, catalog)).toEqual([
      { blockIndex: 0, title: "Chapter One", titleTranslated: null },
      { blockIndex: 2, title: "Chapter Three", titleTranslated: "Глава три" },
    ]);
  });

  it("nulls blank titles and supports the legacy ids shape", () => {
    expect(parseSelectionResponse('{"selections": [{"id": "h_0001", "title": "  "}]}', catalog)).toEqual([
      { blockIndex: 1, title: null, titleTranslated: null },
    ]);
    expect(parseSelectionResponse('{"ids": ["h_0002", "h_0000"]}', catalog)).toEqual([
      { blockIndex: 0, title: null, titleTranslated: null },
      { blockIndex: 2, title: null, titleTranslated: null },
    ]);
  });

  it("drops unknown ids and duplicates", () => {
    expect(parseSelectionResponse('{"ids": ["h_0000", "h_0000", "h_9999"]}', catalog)).toEqual([
      { blockIndex: 0, title: null, titleTranslated: null },
    ]);
  });

  it("falls back to regex extraction on non-JSON output", () => {
    expect(parseSelectionResponse("I picked h_0001 and h_0002.", catalog)?.map((s) => s.blockIndex)).toEqual([1, 2]);
  });

  it("accepts a bare array", () => {
    expect(parseSelectionResponse('["h_0001"]', catalog)?.map((s) => s.blockIndex)).toEqual([1]);
  });

  it("rejects a rubber-stamp selection of a large catalog", () => {
    const big = buildHeadingCatalog(Array.from({ length: 30 }, (_, i) => heading(`H${i}`, i + 1)));
    const allIds = JSON.stringify({ ids: big.map((h) => h.id) });
    expect(parseSelectionResponse(allIds, big)).toBeNull();
    const partial = JSON.stringify({ ids: big.slice(0, 10).map((h) => h.id) });
    expect(parseSelectionResponse(partial, big)).toHaveLength(10);
  });
});

describe("buildSelectionPrompt", () => {
  const catalog = buildHeadingCatalog([heading("Chapter 1", 5)]);

  it("includes toc entries when found", () => {
    const { user } = buildSelectionPrompt(
      { found: true, tocPages: [2], entries: [{ title: "Chapter 1", page: 9 }] },
      catalog
    );
    expect(user).toContain('- "Chapter 1" (p. 9)');
    expect(user).toContain('h_0000 p5 l1 "Chapter 1"');
  });

  it("says so when no toc was found", () => {
    const { user } = buildSelectionPrompt(null, catalog);
    expect(user).toContain("No table of contents was found");
    expect(user).not.toContain('"translated"');
  });

  it("asks for translated titles when a target language is set", () => {
    const { user } = buildSelectionPrompt(null, catalog, { translateTo: "English" });
    expect(user).toContain('"translated": "title in English"');
  });
});

describe("detectChaptersWithLlm", () => {
  beforeEach(() => {
    mockChat.mockReset();
  });

  const blocks = [
    heading("Contents", 2),
    heading("Chapter 1", 5),
    block({ text: "text", page: 6 }),
    heading("Chapter 2", 9),
  ];

  it("runs one toc call and one selection call per file, excluding toc pages", async () => {
    mockChat
      .mockResolvedValueOnce('{"found": true, "tocPages": [2], "entries": [{"title": "Chapter 1", "page": 5}]}')
      .mockResolvedValueOnce('{"selections": [{"id": "h_0001", "title": "Chapter 1"}, {"id": "h_0003", "title": "Chapter 2"}]}');

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog);

    expect(result?.get(null)).toEqual([
      { blockIndex: 1, title: "Chapter 1", titleTranslated: null },
      { blockIndex: 3, title: "Chapter 2", titleTranslated: null },
    ]);
    expect(mockChat).toHaveBeenCalledTimes(2);
    const selectionUser = mockChat.mock.calls[1]?.[1];
    expect(selectionUser).not.toContain('"Contents"');
    expect(selectionUser).toContain('h_0001 p5 l1 "Chapter 1"');
  });

  it("returns null when fewer than two boundaries were selected overall", async () => {
    mockChat
      .mockResolvedValueOnce('{"found": false, "tocPages": [], "entries": []}')
      .mockResolvedValueOnce('{"ids": ["h_0001"]}');

    expect(await detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog)).toBeNull();
  });

  it("degrades to headings-alone when the toc call errors, and fails only when all selection calls error", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("DeepSeek returned an empty response"))
      .mockResolvedValueOnce('{"ids": ["h_0001", "h_0003"]}');

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog);
    expect(result?.get(null)?.map((s) => s.blockIndex)).toEqual([1, 3]);

    mockChat.mockReset();
    mockChat
      .mockResolvedValueOnce('{"found": false, "tocPages": [], "entries": []}')
      .mockRejectedValueOnce(new Error("DeepSeek API error 500"));

    await expect(detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog)).rejects.toThrow("500");
  });

  it("retries with feedback when far fewer headings than toc entries were selected", async () => {
    const many = Array.from({ length: 12 }, (_, i) => heading(`Tale ${i + 1}`, i + 10));
    const entries = many.map((h, i) => `{"title": "${h.text}", "page": ${i + 10}}`).join(", ");
    mockChat
      .mockResolvedValueOnce(`{"found": true, "tocPages": [1], "entries": [${entries}]}`)
      .mockResolvedValueOnce('{"ids": ["h_0000", "h_0001"]}')
      .mockResolvedValueOnce(`{"ids": ${JSON.stringify(many.map((_, i) => `h_${String(i).padStart(4, "0")}`))}}`);

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks: many }], noopLog);

    expect(mockChat).toHaveBeenCalledTimes(3);
    expect(mockChat.mock.calls[2]?.[1]).toContain("A previous attempt selected only 2 headings");
    expect(result?.get(null)).toHaveLength(12);
  });

  it("runs a toc call per file and aggregates selections", async () => {
    mockChat
      .mockResolvedValueOnce('{"found": false, "tocPages": [], "entries": []}')
      .mockResolvedValueOnce('{"ids": ["h_0001"]}')
      .mockResolvedValueOnce('{"found": false, "tocPages": [], "entries": []}')
      .mockResolvedValueOnce('{"ids": ["h_0000"]}');

    const result = await detectChaptersWithLlm(
      [
        { fileIndex: 0, blocks },
        { fileIndex: 1, blocks: [heading("Part II", 1)] },
      ],
      noopLog
    );
    expect(mockChat).toHaveBeenCalledTimes(4);
    expect(result?.get(0)).toEqual([{ blockIndex: 1, title: null, titleTranslated: null }]);
    expect(result?.get(1)).toEqual([{ blockIndex: 0, title: null, titleTranslated: null }]);
  });
});
