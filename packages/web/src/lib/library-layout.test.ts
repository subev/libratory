import { describe, expect, it } from "vitest";
import { libraryLayout } from "./library-layout.ts";

describe("libraryLayout", () => {
  it("shows the full chrome at the widest step", () => {
    expect(libraryLayout(1440)).toEqual({ showLabels: true, trayCompact: false });
  });

  it("collapses labels and the tray below 1000", () => {
    expect(libraryLayout(999)).toEqual({ showLabels: false, trayCompact: true });
  });

  // Inclusive on the roomy side — off by one here is chrome that never appears.
  it("turns labels on exactly at 1000", () => {
    expect(libraryLayout(1000).showLabels).toBe(true);
    expect(libraryLayout(999).showLabels).toBe(false);
  });
});
