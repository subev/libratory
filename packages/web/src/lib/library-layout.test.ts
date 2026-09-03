import { describe, expect, it } from "vitest";
import { libraryLayout } from "./library-layout.ts";

describe("libraryLayout", () => {
  it("shows every column above the widest step", () => {
    expect(libraryLayout(1440)).toEqual({
      showLabels: true,
      showSize: true,
      showOutputs: true,
      showLangs: true,
      trayCompact: false,
    });
  });

  it("drops Languages below 1180 and Outputs below 1080", () => {
    expect(libraryLayout(1179)).toMatchObject({ showLangs: false, showOutputs: true });
    expect(libraryLayout(1079)).toMatchObject({ showOutputs: false, showSize: true });
  });

  it("collapses labels, Size and the tray below 1000", () => {
    expect(libraryLayout(999)).toMatchObject({ showLabels: false, showSize: false, trayCompact: true });
  });

  // Each boundary is inclusive on the roomy side — off by one here is a column that never appears.
  it.each([
    [1000, "showSize"],
    [1080, "showOutputs"],
    [1180, "showLangs"],
  ] as const)("turns %s on exactly at its own width", (width, key) => {
    expect(libraryLayout(width)[key]).toBe(true);
    expect(libraryLayout(width - 1)[key]).toBe(false);
  });
});
