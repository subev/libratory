import { describe, expect, it } from "vitest";

import { cueMark, locateSpans } from "./text-cues.ts";
import type { ReaderCue, ReaderCues } from "./reader-doc.ts";

const cues = (...list: ReaderCue[]): ReaderCues => ({ format: "test", totalMs: 0, granularity: "word", cues: list });
const cue = (s: string, t: [number, number], w?: [number, number, string][]): ReaderCue => ({ s, t, c: 0, ...(w ? { w } : {}) });

describe("locateSpans", () => {
  it("finds a sentence across the line breaks the text has and the cue does not", () => {
    const text = "One morning,\nquite early,\nshe left.";
    expect(locateSpans(text, ["One morning, quite early, she left."])).toEqual([{ start: 0, end: text.length }]);
  });

  it("keeps the paragraph offsets, so a mark lands in the text as written", () => {
    const text = "First para.\n\nSecond para.";
    expect(locateSpans(text, ["Second para."])).toEqual([{ start: 13, end: 25 }]);
    expect(text.slice(13, 25)).toBe("Second para.");
  });

  it("resolves a repeated sentence to sequential, non-overlapping spans", () => {
    const text = "Yes. Yes. No.";
    expect(locateSpans(text, ["Yes.", "Yes."])).toEqual([{ start: 0, end: 4 }, { start: 5, end: 9 }]);
  });

  it("reports a sentence the text no longer contains rather than guessing", () => {
    expect(locateSpans("Rewritten by hand.", ["The sentence that was narrated."])).toEqual([null]);
  });

  it("marks an edited chapter's own text — it is only text", () => {
    const text = "Rewritten by hand, so the print says something else now.";
    expect(locateSpans(text, ["Rewritten by hand, so the print says something else now."])).toEqual([
      { start: 0, end: text.length },
    ]);
  });
});

describe("cueMark", () => {
  const text = "One.\n\nTwo.";
  const doc = cues(
    cue("One.", [0, 1000], [[0, 400, "One"]]),
    cue("Two.", [1000, 2000], [[1000, 1400, "Two"]]),
  );
  const spans = locateSpans(text, doc.cues.map((c) => c.s));

  it("marks the sentence being spoken, and the word inside it", () => {
    expect(cueMark(text, spans, doc, 1200)).toEqual({ start: 6, end: 10, word: { start: 6, end: 9 } });
  });

  it("marks no word in the silence after one", () => {
    expect(cueMark(text, spans, doc, 600)?.word).toBeNull();
  });

  it("marks nothing when the narration has no cues, or its sentence is gone", () => {
    expect(cueMark(text, spans, null, 0)).toBeNull();
    expect(cueMark(text, [null, null], doc, 0)).toBeNull();
  });

  it("keeps a repeated word on the one being spoken, not the first that matches", () => {
    const line = "the cat and the dog";
    const spoken = cues(cue(line, [0, 900], [[0, 100, "the"], [100, 200, "cat"], [200, 300, "and"], [300, 400, "the"], [400, 500, "dog"]]));
    const at = locateSpans(line, [line]);
    expect(cueMark(line, at, spoken, 350)?.word).toEqual({ start: 12, end: 15 });
  });
});
