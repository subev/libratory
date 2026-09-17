import { expect, it } from "vitest";
import { transcriptSegments, transcriptWordRange } from "./transcript-segments.ts";
import type { ReaderCue } from "./reader-doc.ts";

it("splits a cue across semantic blocks without dropping unspoken text or changing offsets", () => {
  const cue: ReaderCue = { t: [0, 100], c: 0, s: "Left Right", range: [0, 10], w: [[0, 50, "Left"], [50, 100, "Right"]] };
  const text = "Left\nRight\n\n14 Note";
  expect(transcriptSegments(0, 4, [cue])).toEqual([{ start: 0, end: 4, cue: 0 }]);
  expect(transcriptSegments(5, 10, [cue])).toEqual([{ start: 5, end: 10, cue: 0 }]);
  expect(transcriptSegments(12, text.length, [cue])).toEqual([{ start: 12, end: text.length, cue: null }]);
  expect(transcriptWordRange(text, cue, 1)).toEqual({ start: 5, end: 10 });
});
