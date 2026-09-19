import { describe, expect, it } from "vitest";

import { cueTimeAtOffset } from "./citation-targets.ts";
import type { SyncMap } from "./sync-map.ts";

const text = "First sentence here.\n\nSecond one follows.  Third closes it.";
const map: SyncMap = {
  version: 1,
  totalMs: 9000,
  chunks: [
    { text: "First sentence here.", startMs: 0, endMs: 3000 },
    { text: "Second one follows.", startMs: 3000, endMs: 6000 },
    { text: "Third closes it.", startMs: 6000, endMs: 9000 },
  ],
};

describe("cueTimeAtOffset", () => {
  it("answers with the start of the cue holding the offset", () => {
    expect(cueTimeAtOffset(text, map, 0)).toBe(0);
    expect(cueTimeAtOffset(text, map, text.indexOf("one"))).toBe(3000);
    expect(cueTimeAtOffset(text, map, text.indexOf("closes"))).toBe(6000);
  });

  it("takes the next cue when the offset falls in the whitespace between two", () => {
    expect(cueTimeAtOffset(text, map, text.indexOf("\n"))).toBe(3000);
  });

  it("has no answer when the narration was made from another text", () => {
    expect(cueTimeAtOffset("Something else entirely.", map, 0)).toBeNull();
  });

  it("has no answer past the end of the narration", () => {
    expect(cueTimeAtOffset(text, map, text.length + 10)).toBeNull();
  });
});
