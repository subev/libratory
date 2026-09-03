import { describe, expect, it } from "vitest";
import { sameFlags } from "./use-layout-state.ts";
import { bookLayout } from "./book-layout.ts";
import { libraryLayout } from "./library-layout.ts";

// The shells bail on this rather than publishing ~60 identical layouts a second during a drag.
describe("sameFlags", () => {
  it("holds across widths inside one step and breaks across a boundary", () => {
    expect(sameFlags(bookLayout(1200), bookLayout(1439))).toBe(true);
    expect(sameFlags(bookLayout(1180), bookLayout(1179))).toBe(false);
    expect(sameFlags(bookLayout(1120), bookLayout(1119))).toBe(false);
    expect(sameFlags(bookLayout(1000), bookLayout(999))).toBe(false);
  });

  it("does the same job for the library's own contract", () => {
    expect(sameFlags(libraryLayout(1200), libraryLayout(1440))).toBe(true);
    expect(sameFlags(libraryLayout(1180), libraryLayout(1179))).toBe(false);
    expect(sameFlags(libraryLayout(1080), libraryLayout(1079))).toBe(false);
  });
});
