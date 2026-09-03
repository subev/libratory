import { describe, expect, it } from "vitest";
import { bookLayout, sameLayout } from "./book-layout.ts";

describe("bookLayout", () => {
  it("shows everything at the design's widest step", () => {
    expect(bookLayout(1440)).toEqual({
      showHeadMeta: true,
      showStageHint: true,
      showPosition: true,
      showSource: true,
      showWords: true,
      showDuration: true,
      showPages: true,
      showLabels: true,
      trayCompact: false,
      filterColumns: 2,
    });
  });

  it("drops the head meta, stage hint and book position below 1180", () => {
    const layout = bookLayout(1179);
    expect(layout.showHeadMeta).toBe(false);
    expect(layout.showStageHint).toBe(false);
    expect(layout.showPosition).toBe(false);
    expect(layout.showWords).toBe(true);
  });

  it("drops Words below 1120 and keeps Length", () => {
    expect(bookLayout(1119).showWords).toBe(false);
    expect(bookLayout(1119).showDuration).toBe(true);
  });

  it("collapses labels, Length, pages and the tray below 1000", () => {
    expect(bookLayout(999)).toMatchObject({
      showDuration: false,
      showPages: false,
      showLabels: false,
      trayCompact: true,
      filterColumns: 1,
    });
  });

  // Each boundary is inclusive on the roomy side — off by one here is a column that never appears.
  it.each([
    [1180, "showHeadMeta"],
    [1120, "showWords"],
    [1000, "showDuration"],
  ] as const)("turns %s on exactly at its own width", (width, key) => {
    expect(bookLayout(width)[key]).toBe(true);
    expect(bookLayout(width - 1)[key]).toBe(false);
  });
});

describe("sameLayout", () => {
  // The provider bails on this rather than publishing ~60 identical layouts a second during a drag.
  it("holds across widths inside one step and breaks across a boundary", () => {
    expect(sameLayout(bookLayout(1200), bookLayout(1439))).toBe(true);
    expect(sameLayout(bookLayout(1180), bookLayout(1179))).toBe(false);
    expect(sameLayout(bookLayout(1120), bookLayout(1119))).toBe(false);
    expect(sameLayout(bookLayout(1000), bookLayout(999))).toBe(false);
  });
});
