import { describe, expect, it } from "vitest";
import { bookLayout } from "./book-layout.ts";

describe("bookLayout", () => {
  it("shows everything at the design's widest step", () => {
    expect(bookLayout(1440)).toEqual({
      showHeadMeta: true,
      showStageHint: true,
      showPosition: true,
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
    expect(layout.showLabels).toBe(true);
  });

  it("collapses labels, the tray and the filter grid below 1000", () => {
    expect(bookLayout(999)).toMatchObject({
      showLabels: false,
      trayCompact: true,
      filterColumns: 1,
    });
  });

  // Each boundary is inclusive on the roomy side — off by one here is chrome that never appears.
  it.each([
    [1180, "showHeadMeta"],
    [1000, "showLabels"],
  ] as const)("turns %s on exactly at its own width", (width, key) => {
    expect(bookLayout(width)[key]).toBe(true);
    expect(bookLayout(width - 1)[key]).toBe(false);
  });
});
