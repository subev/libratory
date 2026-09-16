import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, bookFiles } from "../schema.ts";
import { runLlmOcr } from "./ocr-llm.ts";
import { pdfHasTextLayer } from "./pdf-raw-text.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});
vi.mock("./ocr-llm.ts", async (original) => ({
  ...await original<typeof import("./ocr-llm.ts")>(), runLlmOcr: vi.fn(),
}));
vi.mock("./pdf-raw-text.ts", async (original) => ({
  ...await original<typeof import("./pdf-raw-text.ts")>(), pdfHasTextLayer: vi.fn(),
}));

import type { FlatBlock, SourceBlock } from "./marker.ts";
import { ensureTextLayer, matchBlockPolygons } from "./ocr-text-layer.ts";

const fresh = (page: number, text: string, polygon?: number[][]): FlatBlock => ({ type: "Text", text, hierarchy: null, page, included: true, ...(polygon ? { polygon } : {}) });
const source = (page: number, text: string, polygon?: number[][]): SourceBlock => ({ type: "Text", text, page, included: true, ...(polygon ? { polygon } : {}) });

describe("replacing imported PDF text", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    vi.mocked(pdfHasTextLayer).mockReset().mockResolvedValue(true);
    vi.mocked(runLlmOcr).mockReset().mockResolvedValue({
      pages: 2, inputTokens: 100, outputTokens: 100, meanRecall: 1, lowRecallFraction: 0,
      flaggedPages: [], meanPlaced: 1, searchableCopy: true, rawText: "New transcription from every page.",
    });
  });

  async function importedFile() {
    const book = row(await getDb().insert(books).values({ title: "Imported scan", language: "en" }).returning());
    const file = row(await getDb().insert(bookFiles).values({
      bookId: book.id, index: 0, filename: "scan.pdf", pdfPath: "/tmp/imported-scan.pdf", rawText: "Bad imported OCR",
    }).returning());
    return { bookId: book.id, file, engine: "llm" as const, language: "en", log: vi.fn(async () => {}) };
  }

  it("keeps the ordinary skip but explicitly re-reads a PDF with imported text", async () => {
    const input = await importedFile();
    expect(await ensureTextLayer(input)).toBe(false);
    expect(runLlmOcr).not.toHaveBeenCalled();

    expect(await ensureTextLayer({ ...input, ignoreTextLayer: true })).toBe(true);
    expect(runLlmOcr).toHaveBeenCalledWith(expect.objectContaining({ pdfPath: input.file.pdfPath }));
    const file = row(await getDb().select().from(bookFiles).where(eq(bookFiles.id, input.file.id)));
    expect(file).toMatchObject({ ocrEngine: "llm", searchablePdfPath: "/tmp/imported-scan.ocr.pdf", rawText: "New transcription from every page." });
  });

  it("bypasses an existing Libratory copy too", async () => {
    const input = await importedFile();
    input.file.searchablePdfPath = "/tmp/imported-scan.ocr.pdf";
    input.file.ocrEngine = "llm";
    expect(await ensureTextLayer({ ...input, ignoreTextLayer: true })).toBe(true);
    expect(runLlmOcr).toHaveBeenCalledOnce();
  });

  it("fails rather than silently returning to the imported layer when replacement fails", async () => {
    const input = await importedFile();
    vi.mocked(runLlmOcr).mockResolvedValue({
      pages: 2, inputTokens: 100, outputTokens: 100, meanRecall: null, lowRecallFraction: null,
      flaggedPages: [], meanPlaced: null, searchableCopy: false, rawText: "Saved AI text",
    });
    await expect(ensureTextLayer({ ...input, ignoreTextLayer: true })).rejects.toThrow("could not replace the PDF text layer");
    const file = row(await getDb().select().from(bookFiles).where(eq(bookFiles.id, input.file.id)));
    expect(file).toMatchObject({ searchablePdfPath: null, rawText: "Bad imported OCR" });
  });
});

describe("matchBlockPolygons", () => {
  it("gives each chapter block the polygon of the same block in the new layout, by page and text", () => {
    const { blocks, matched } = matchBlockPolygons(
      [source(3, "Беше нощ.", [[0, 0], [1, 0], [1, 1], [0, 1]]), source(3, "И валеше сняг, и духаше вятър, и никой не спеше в цялото село онази нощ."), source(4, "Сутринта.")],
      [fresh(3, "Беше нощ.", [[10, 10], [20, 10], [20, 20], [10, 20]]), fresh(3, "И валеше сняг, и духаше вятър, и никой не спеше в цялото село онази нощ, а после", [[5, 5], [6, 5], [6, 6], [5, 6]]), fresh(4, "Сутринта.")],
    );
    expect(matched).toBe(3);
    // An exact match on the same page; a changed ending falls through to the text's start
    expect(blocks[0]?.polygon).toEqual([[10, 10], [20, 10], [20, 20], [10, 20]]);
    expect(blocks[1]?.polygon).toEqual([[5, 5], [6, 5], [6, 6], [5, 6]]);
  });

  it("binds each new block once, so two blocks with the same text on a page get their own polygons", () => {
    const { blocks } = matchBlockPolygons(
      [source(1, "* * *"), source(1, "* * *")],
      [fresh(1, "* * *", [[1, 1], [2, 1], [2, 2], [1, 2]]), fresh(1, "* * *", [[5, 5], [6, 5], [6, 6], [5, 6]])],
    );
    expect(blocks.map((b) => b.polygon?.[0])).toEqual([[1, 1], [5, 5]]);
  });

  it("drops a stale polygon when the new layout could not place that block, and keeps a block it cannot find", () => {
    const { blocks, matched } = matchBlockPolygons(
      [source(1, "Placed once.", [[0, 0], [1, 0], [1, 1], [0, 1]]), source(1, "Never seen again.", [[2, 2], [3, 2], [3, 3], [2, 3]])],
      [fresh(1, "Placed once."), fresh(2, "Never seen again.", [[9, 9], [9, 9], [9, 9], [9, 9]])],
    );
    expect(matched).toBe(1);
    expect(blocks[0]).toEqual(source(1, "Placed once."));
    expect(blocks[1]?.polygon).toEqual([[2, 2], [3, 2], [3, 3], [2, 3]]);
  });
});
