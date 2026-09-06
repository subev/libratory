import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./llm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm.ts")>()),
  llmChat: vi.fn(),
}));

import { llmChat } from "./llm.ts";
import {
  buildHeadingCatalog,
  buildPageWindow,
  buildResolvePrompt,
  buildSelectionPrompt,
  buildTierPrompt,
  detectChaptersWithLlm,
  layoutText,
  mergePageTexts,
  parseResolveResponse,
  parseSelectionResponse,
  parseTierResponse,
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

  it("includes pages marker produced no blocks for, so the pdf layer can fill them", () => {
    const gappy = [block({ text: "one", page: 1 }), block({ text: "two", page: 2 }), block({ text: "four", page: 4 })];
    const window = buildPageWindow(gappy, "head");
    expect(window.pages).toEqual([1, 2, 3, 4]);
    expect(window.entries[2]).toEqual({ page: 3, text: "" });
    expect(mergePageTexts(window.entries, new Map([[3, "Contents\n Chapter 1  5"]]))).toContain("p3:\nContents\n Chapter 1  5");
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

describe("layoutText", () => {
  it("keeps indentation, collapses page-number padding and blank runs", () => {
    const raw = "Contents\n\n\n Introduction                 3\n      Neuro-linguistic Programming    3   \n\f";
    expect(layoutText(raw)).toBe("Contents\n\n Introduction  3\n      Neuro-linguistic Programming  3");
  });
});

describe("mergePageTexts", () => {
  it("keeps the text with more content per page, ignoring layout padding", () => {
    const entries = [
      { page: 5, text: "marker text that is long enough to win here" },
      { page: 6, text: "TABLE OF CONTENTS." },
    ];
    const layer = new Map([
      [5, "short         layer         padded"],
      [6, "TABLE OF CONTENTS.\n PRELIMINARY  5\n I. ORIGIN OF THE JEWS  8"],
    ]);
    const text = mergePageTexts(entries, layer);
    expect(text).toContain("p5:\nmarker text that is long enough to win here");
    expect(text).toContain("p6:\nTABLE OF CONTENTS.\n PRELIMINARY  5");
  });

  it("uses marker text when the layer is missing", () => {
    const text = mergePageTexts([{ page: 1, text: "only marker" }], new Map());
    expect(text).toBe("p1:\nonly marker");
  });
});

describe("buildHeadingCatalog", () => {
  it("catalogs included SectionHeaders with ids mapping to block indices and the words that follow", () => {
    const blocks = [
      block({ text: "intro para" }),
      heading("Chapter 1", 5),
      block({ text: "one two three", page: 5 }),
      block({ type: "PageHeader", text: "running head", included: false }),
      heading("Chapter 2", 9, 2),
      block({ text: "four", page: 9 }),
    ];
    expect(buildHeadingCatalog(blocks)).toEqual([
      { id: "h_0001", blockIndex: 1, page: 5, level: 1, text: "Chapter 1", words: 5 },
      { id: "h_0004", blockIndex: 4, page: 9, level: 2, text: "Chapter 2", words: 3 },
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
  it("parses a valid response with levels", () => {
    const result = parseTocResponse(
      '{"found": true, "tocPages": [8, 9], "entries": [{"title": "Part One", "page": 1, "level": 0}, {"title": "Chapter 1", "page": 12, "level": 1}, {"title": "Epilogue", "page": null}]}'
    );
    expect(result).toEqual({
      found: true,
      tocPages: [8, 9],
      entries: [
        { title: "Part One", page: 1, level: 0 },
        { title: "Chapter 1", page: 12, level: 1 },
        { title: "Epilogue", page: null, level: null },
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
      '{"found": true, "tocPages": [0, "x", 3], "entries": [{"title": "", "page": 1}, {"title": "Ok", "page": "12", "level": -1}, {"title": "Preface", "page": "xv"}, "junk"]}'
    );
    expect(result).toEqual({
      found: true,
      tocPages: [3],
      entries: [
        { title: "Ok", page: 12, level: null },
        { title: "Preface", page: null, level: null },
      ],
    });
  });

  it("salvages JSON wrapped in prose", () => {
    const result = parseTocResponse(
      'Here is the result:\n{"found": true, "tocPages": [4], "entries": [{"title": "Ch 1", "page": 9}]}\nLet me know!'
    );
    expect(result).toEqual({ found: true, tocPages: [4], entries: [{ title: "Ch 1", page: 9, level: null }] });
  });

  it("returns null for non-JSON", () => {
    expect(parseTocResponse("I could not find a table of contents.")).toBeNull();
  });
});

describe("tier prompt and response", () => {
  const toc = {
    found: true,
    tocPages: [2],
    entries: [
      { title: "Part One", page: 1, level: 0 },
      { title: "Introduction", page: 3, level: 1 },
      { title: "Neuro-linguistic Programming", page: 3, level: 2 },
    ],
  };

  it("lists entries with their index, level and printed page", () => {
    const { user } = buildTierPrompt(toc, { translateTo: "English" });
    expect(user).toContain('[1] L1 "Introduction" p3');
    expect(user).toContain('"translated": "title in English"');
  });

  it("keeps valid indices in order, falling back to the printed title", () => {
    expect(parseTierResponse('{"chapters": [{"i": 2, "title": " "}, {"i": 1, "title": "Introduction", "translated": "Въведение"}, {"i": 7}, {"i": 1}]}', toc)).toEqual([
      { i: 1, title: "Introduction", translated: "Въведение" },
      { i: 2, title: "Neuro-linguistic Programming", translated: null },
    ]);
    expect(parseTierResponse("nonsense", toc)).toEqual([]);
  });
});

describe("resolve prompt and response", () => {
  const catalog = buildHeadingCatalog([heading("Wfiere rnO :YOU 1(now %at?", 53), heading("Other Contexts", 54)]);
  const unresolved = [{ entry: 4, expectedPage: 53, candidates: catalog }];

  it("shows each entry with its expected page and nearby headings", () => {
    const { user } = buildResolvePrompt([{ entry: unresolved[0]!, title: "Where Do You Know That?", printedPage: 48 }]);
    expect(user).toContain('ENTRY [4] "Where Do You Know That?" (printed p. 48, expected around PDF p. 53)');
    expect(user).toContain('  h_0000 p53 +5w "Wfiere rnO :YOU 1(now %at?"');
  });

  it("accepts only listed candidates", () => {
    expect(parseResolveResponse('{"matches": [{"i": 4, "id": "h_0000"}, {"i": 9, "id": "h_0001"}]}', unresolved)).toEqual(new Map([[4, 0]]));
    expect(parseResolveResponse('{"matches": [{"i": 4, "id": null}]}', unresolved)).toEqual(new Map());
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
  const catalog = buildHeadingCatalog([heading("Chapter 1", 5), block({ text: "one two", page: 5 })]);

  it("includes toc entries when found and the words after each heading", () => {
    const { user } = buildSelectionPrompt(
      { found: true, tocPages: [2], entries: [{ title: "Chapter 1", page: 9, level: null }] },
      catalog
    );
    expect(user).toContain('- "Chapter 1" (p. 9)');
    expect(user).toContain('h_0000 p5 l1 +4w "Chapter 1"');
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
  const notFound = '{"found": false, "tocPages": [], "entries": []}';

  it("runs toc and tier calls per file, placing chapters without asking when titles match", async () => {
    mockChat
      .mockResolvedValueOnce('{"found": true, "tocPages": [2], "entries": [{"title": "Chapter 1", "page": 5, "level": 0}, {"title": "Chapter 2", "page": 9, "level": 0}]}')
      .mockResolvedValueOnce('{"chapters": [{"i": 0, "title": "Chapter One"}, {"i": 1, "title": "Chapter Two"}]}');

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog);

    expect(result?.selected.get(null)).toEqual([
      { blockIndex: 1, title: "Chapter One", titleTranslated: null },
      { blockIndex: 3, title: "Chapter Two", titleTranslated: null },
    ]);
    expect(result?.toc).toEqual([
      {
        fileIndex: null,
        pages: [2],
        entries: [{ title: "Chapter 1", page: 5, level: 0 }, { title: "Chapter 2", page: 9, level: 0 }],
        chapterEntries: 2,
        offsets: null,
      },
    ]);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1]?.[1]).toContain('[0] L0 "Chapter 1" p5');
  });

  it("maps printed pages to PDF pages and asks the model only about headings it cannot read", async () => {
    const many = [
      heading("Contents", 1),
      heading("Chapter 1", 5), block({ text: "a", page: 6 }),
      heading("Chapter 2", 9), block({ text: "b", page: 10 }),
      heading("Chapter 3", 13), block({ text: "c", page: 14 }),
      heading("Cliapter Fuor", 17), block({ text: "d", page: 18 }),
      heading("Chapter 5", 21), block({ text: "e", page: 22 }),
    ];
    const entries = [3, 7, 11, 15, 19].map((page, i) => `{"title": "Chapter ${i + 1}", "page": ${page}, "level": 0}`).join(", ");
    mockChat
      .mockResolvedValueOnce(`{"found": true, "tocPages": [1], "entries": [${entries}]}`)
      .mockResolvedValueOnce(`{"chapters": [${[0, 1, 2, 3, 4].map((i) => `{"i": ${i}, "title": "Chapter ${i + 1}"}`).join(", ")}]}`)
      .mockResolvedValueOnce('{"matches": [{"i": 3, "id": "h_0007"}]}');

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks: many }], noopLog);

    expect(result?.selected.get(null)?.map((s) => s.blockIndex)).toEqual([1, 3, 5, 7, 9]);
    expect(result?.toc[0]?.offsets).toBe("+2");
    expect(mockChat).toHaveBeenCalledTimes(3);
    const resolveUser = mockChat.mock.calls[2]?.[1];
    expect(resolveUser).toContain('ENTRY [3] "Chapter 4" (printed p. 15, expected around PDF p. 17)');
    expect(resolveUser).toContain('h_0007 p17 +3w "Cliapter Fuor"');
    expect(resolveUser).not.toContain("ENTRY [0]");
  });

  it("falls back to the heading catalog without a toc, showing the words after each heading", async () => {
    const many = [
      heading("Chapter 1", 5), block({ text: "a", page: 6 }),
      heading("Chapter 2", 9), block({ text: "b", page: 10 }),
      heading("Chapter 3", 13), block({ text: "c", page: 14 }),
    ];
    mockChat
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce('{"selections": [{"id": "h_0000", "title": "One"}, {"id": "h_0004", "title": "Three"}]}');

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks: many }], noopLog);

    expect(result?.selected.get(null)).toEqual([
      { blockIndex: 0, title: "One", titleTranslated: null },
      { blockIndex: 4, title: "Three", titleTranslated: null },
    ]);
    expect(result?.toc).toEqual([]);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1]?.[1]).toContain('h_0000 p5 l1 +3w "Chapter 1"');
  });

  it("returns null when fewer than two boundaries were selected overall", async () => {
    mockChat.mockResolvedValueOnce(notFound).mockResolvedValueOnce('{"ids": ["h_0001"]}');

    expect(await detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog)).toBeNull();
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it("degrades to headings-alone when the toc call errors, and fails only when all selection calls error", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("DeepSeek returned an empty response"))
      .mockResolvedValueOnce('{"ids": ["h_0001", "h_0003"]}');

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog);
    expect(result?.selected.get(null)?.map((s) => s.blockIndex)).toEqual([1, 3]);

    mockChat.mockReset();
    mockChat.mockResolvedValueOnce(notFound).mockRejectedValueOnce(new Error("DeepSeek API error 500"));

    await expect(detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog)).rejects.toThrow("500");
  });

  it("selects from headings when the toc has entries but the model finds no chapters among them", async () => {
    mockChat
      .mockResolvedValueOnce('{"found": true, "tocPages": [2], "entries": [{"title": "Chapter 1", "page": 5}, {"title": "Chapter 2", "page": 9}]}')
      .mockResolvedValueOnce('{"chapters": []}')
      .mockResolvedValueOnce('{"ids": ["h_0001", "h_0003"]}');

    const result = await detectChaptersWithLlm([{ fileIndex: null, blocks }], noopLog);
    expect(result?.selected.get(null)?.map((s) => s.blockIndex)).toEqual([1, 3]);
    expect(result?.toc[0]?.chapterEntries).toBe(0);
    expect(mockChat.mock.calls[2]?.[1]).toContain("TABLE OF CONTENTS");
  });

  it("records the table of contents only for files whose selection was kept", async () => {
    const big = Array.from({ length: 25 }, (_, i) => heading(`H${i}`, i + 1));
    mockChat
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce('{"ids": ["h_0001", "h_0003"]}')
      .mockResolvedValueOnce('{"found": true, "tocPages": [], "entries": [{"title": "Chapter 1", "page": 5}, {"title": "Chapter 2", "page": 9}]}')
      .mockResolvedValueOnce('{"chapters": []}')
      .mockResolvedValueOnce(JSON.stringify({ ids: big.map((_, i) => `h_${String(i).padStart(4, "0")}`) }));

    const result = await detectChaptersWithLlm([{ fileIndex: 0, blocks }, { fileIndex: 1, blocks: big }], noopLog);

    expect(result?.selected.has(1)).toBe(false);
    expect(result?.toc).toEqual([]);
  });

  it("runs a toc call per file and aggregates selections", async () => {
    mockChat
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce('{"ids": ["h_0001"]}')
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce('{"ids": ["h_0000"]}');

    const result = await detectChaptersWithLlm(
      [
        { fileIndex: 0, blocks },
        { fileIndex: 1, blocks: [heading("Part II", 1)] },
      ],
      noopLog
    );
    expect(mockChat).toHaveBeenCalledTimes(4);
    expect(result?.selected.get(0)).toEqual([{ blockIndex: 1, title: null, titleTranslated: null }]);
    expect(result?.selected.get(1)).toEqual([{ blockIndex: 0, title: null, titleTranslated: null }]);
  });
});
