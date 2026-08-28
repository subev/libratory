import { describe, expect, it } from "vitest";

import { medianBodyPt, pageLayout, type GeometryLine, type GeometryPage } from "./page-geometry.ts";

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

  it("keeps a heading that spans both columns from widening either one", () => {
    const lines = [line(50, 250, 20, 14), ...rows.flatMap((top) => [line(50, 140, top), line(160, 250, top)])];

    const { columns } = pageLayout(page(lines));

    // The heading lands in one column; clamping at the gutter stops it spilling over the other
    expect(columns).toHaveLength(2);
    expect((columns[0]?.[0] ?? 0) + (columns[0]?.[2] ?? 0)).toBe(140);
    expect(columns[1]?.[0]).toBeGreaterThanOrEqual(140);
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
