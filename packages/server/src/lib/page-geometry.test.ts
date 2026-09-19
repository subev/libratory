import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ensureSourceGeometry, medianBodyPt, pageLayout, removeSourceGeometry, type GeometryLine, type GeometryPage } from "./page-geometry.ts";

function line(x0: number, x1: number, top: number, height = 10): GeometryLine {
  return { b: [x0, top, x1, top + height], t: "x".repeat(Math.round((x1 - x0) / 5)) };
}

function page(lines: GeometryLine[]): GeometryPage {
  return { i: 0, w: 300, h: 400, rot: 0, cropOffset: [0, 0], lines };
}

const rows = [40, 55, 70, 85, 100, 115, 130, 145, 160, 175];

describe("pageLayout", () => {
  it("reads a single column as one column spanning the text", () => {
    const layout = pageLayout(page(rows.map((top) => line(50, 250, top))));

    expect(layout.content).toEqual([50, 40, 200, 145]);
    expect(layout.columns).toEqual([layout.content]);
  });

  it("splits a two-column page at the gutter", () => {
    const lines = rows.flatMap((top) => [line(50, 140, top), line(160, 250, top)]);

    const { columns } = pageLayout(page(lines));

    expect(columns).toEqual([
      [50, 40, 90, 145],
      [160, 40, 90, 145],
    ]);
  });

  it("gives a heading that spans both columns a crop of its own, above them", () => {
    const lines = [line(50, 250, 20, 14), ...rows.flatMap((top) => [line(50, 140, top), line(160, 250, top)])];

    expect(pageLayout(page(lines)).columns).toEqual([
      [50, 20, 200, 14],
      [50, 40, 90, 145],
      [160, 40, 90, 145],
    ]);
  });

  it("reads a page of two-column blocks under their own headings one block at a time", () => {
    const block = (from: number) => [0, 15, 30, 45, 60].flatMap((dy) => [line(50, 140, from + dy), line(160, 250, from + dy)]);
    // The second heading is a few centred words, narrower than a column
    const lines = [...block(40), line(120, 180, 125), ...block(150)];

    expect(pageLayout(page(lines)).columns).toEqual([
      [50, 40, 90, 70],
      [160, 40, 90, 70],
      [105, 125, 90, 10],
      [50, 150, 90, 70],
      [160, 150, 90, 70],
    ]);
  });

  it("treats a ragged single column as one column, not two", () => {
    // Short lines leave gaps on the right, which a naive gutter search would split on
    const lines = rows.map((top, i) => line(50, i % 2 === 0 ? 250 : 180, top));

    expect(pageLayout(page(lines)).columns).toHaveLength(1);
  });

  it("falls back to the whole page when there is no text layer", () => {
    expect(pageLayout(page([]))).toEqual({ content: [0, 0, 300, 400], columns: [[0, 0, 300, 400]] });
  });
});

describe("medianBodyPt", () => {
  it("measures the body from line boxes, weighted by how much text they hold", () => {
    const body = rows.map((top) => line(50, 250, top, 11));
    const headings = [line(50, 120, 20, 24), line(50, 120, 200, 24)];

    expect(medianBodyPt([page([...body, ...headings])])).toBe(11);
  });

  it("returns null for a page with no text", () => {
    expect(medianBodyPt([page([])])).toBeNull();
  });
});

describe("removeSourceGeometry", () => {
  it("drops the sidecar and the parsed copy of it, so the next read is not the old text layer's", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "geometry-"));
    const target = path.join(outDir, "geometry.json");
    const stale = { version: 4, pages: [{ i: 0, w: 100, h: 100, rot: 0, cropOffset: [0, 0], lines: [] }] };
    await writeFile(target, JSON.stringify(stale));
    // Served as is, and now held in memory
    const source = { fileIndex: 0, filename: "x.pdf", pdfPath: "/nowhere.pdf", outDir };
    expect((await ensureSourceGeometry(source))?.pages).toHaveLength(1);

    await removeSourceGeometry(outDir);
    expect(await stat(target).then(() => true, () => false)).toBe(false);
    await expect(readFile(target)).rejects.toThrow();
    // A second removal of nothing is not an error
    await removeSourceGeometry(outDir);
  });
});

describe("native OCR sidecar", () => {
  it("uses measured geometry while the PDF matches and ignores it after replacement", async () => {
    const { rm } = await import("node:fs/promises");
    const outDir = await mkdtemp(path.join(tmpdir(), "native-geometry-"));
    const pdfPath = path.join(outDir, "scan.pdf");
    try {
      await writeFile(pdfPath, "first PDF");
      const fingerprint = await stat(pdfPath);
      const native = { version: 4, pdf: { path: pdfPath, size: fingerprint.size, mtimeMs: fingerprint.mtimeMs }, pages: [{ ...page([line(10, 20, 30)]), native: { words: [], blocks: [] } }] };
      const fallback = { version: 4, pages: [page([line(100, 200, 300)])] };
      await writeFile(path.join(outDir, "ocr-geometry.json"), JSON.stringify(native));
      await writeFile(path.join(outDir, "geometry.json"), JSON.stringify(fallback));
      const source = { pdfPath, outDir, filename: "scan.pdf", fileIndex: 0 };
      expect(await ensureSourceGeometry(source)).toEqual(native);
      await writeFile(pdfPath, "a different replacement PDF");
      expect(await ensureSourceGeometry(source)).toEqual(fallback);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
