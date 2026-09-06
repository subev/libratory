import { describe, expect, it } from "vitest";

import { isLabelSized, oversizedIndices } from "./chapter-rules.ts";

describe("oversizedIndices", () => {
  it("flags chapters far above the others, never a merely long one", () => {
    expect([...oversizedIndices([500, 800, 22651, 600, 9000, 700])]).toEqual([2, 4]);
    expect([...oversizedIndices([3000, 3500, 6800, 2500])]).toEqual([]);
  });

  it("still sees a swallowed book when only two chapters exist", () => {
    expect([...oversizedIndices([500, 60000])]).toEqual([1]);
    expect([...oversizedIndices([60000])]).toEqual([]);
  });
});

describe("isLabelSized", () => {
  it("flags tiny chapters except the last one", () => {
    expect(isLabelSized(24, 3, 10)).toBe(true);
    expect(isLabelSized(24, 9, 10)).toBe(false);
    expect(isLabelSized(300, 3, 10)).toBe(false);
  });
});
