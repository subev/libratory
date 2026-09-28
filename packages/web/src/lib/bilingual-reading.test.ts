import { describe, it, expect } from "vitest";
import fixture from "../../../server/src/lib/fixtures/bilingual.json";
import { parseBilingualDocument } from "../../../server/src/lib/bilingual-format.ts";
import { linkedText, listenPosition, paragraphGroups, pairPresentation, sharesPrimaryRecording, sentenceSequence, sentenceStartIndex } from "./bilingual-reading.ts";

describe("bilingual reading presentation", () => {
  it("groups sentences by real paragraph gaps without changing their addresses", () => {
    const doc = parseBilingualDocument(fixture);
    doc.source.text = "Title.\n\nOne. Two.\n\nThree.";
    doc.target.text = doc.source.text;
    doc.pairs = [[0, 6], [8, 12], [13, 17], [19, 25]].map(([start = 0, end = 0], i) => ({ id: `p${i}`, status: "matched", source: [start, end], target: [start, end], links: [], linksStatus: "ready" }));
    expect(paragraphGroups(doc).map((group) => group.map((pair) => pair.id))).toEqual([["p0"], ["p1", "p2"], ["p3"]]);
    expect(doc.pairs[2]?.source).toEqual([13, 17]);
  });
  it("shows spaces for adjacent words and an ellipsis only for discontinuous phrases", () => {
    const doc = parseBilingualDocument(fixture);
    expect(linkedText(doc.source, [0, 1])).toBe("turned it");
    expect(linkedText(doc.source, [0, 2])).toBe("turned … off");
  });
  it("clicks use the word's own audio clock, including provider punctuation", () => {
    const doc = parseBilingualDocument(fixture), pair = doc.pairs[0];
    if (!pair || !doc.source.narration) throw new Error("Incomplete fixture");
    doc.source.narration.anchors.push({ kind: "word", range: [0, 7], start: { method: "provider-word", ms: 400 }, end: { method: "provider-word", ms: 600 } });
    expect(listenPosition(doc.source, pair, "source", 0)).toEqual({ ms: 400, word: true });
    expect(listenPosition(doc.target, pair, "target", 0)).toEqual({ ms: 2500, word: false });
    doc.target.narration = null;
    expect(listenPosition(doc.target, pair, "target", 0)).toBeNull();
  });
});

describe("review regressions", () => {
  it.each([
    ["don't", [[0, 3], [3, 5]]],
    ["l'homme", [[0, 1], [1, 7]]],
    ["你好。", [[0, 2], [2, 3]]],
    ["word, next!", [[0, 4], [6, 10]]],
  ])("renders every character once in %s", (text, ranges) => {
    const doc = parseBilingualDocument(fixture);
    doc.source.text = text;
    doc.source.tokens = ranges.map(([start = 0, end = 0], id) => ({ id, range: [start, end] }));
    doc.pairs = [{ id: "p", source: [0, text.length], target: null, status: "source-only", linksStatus: "unavailable", links: [] }];
    const layout = pairPresentation(doc, "source").get("p");
    expect(layout?.tokens.map((piece) => piece.before + piece.text).join("") + (layout?.after ?? "")).toBe(text);
  });
  it("does not transfer milliseconds between different recordings", () => {
    const doc = parseBilingualDocument(fixture);
    expect(sharesPrimaryRecording(doc, doc.source.narration?.audio ?? null)).toBe(true);
    expect(sharesPrimaryRecording(doc, "other-recording.m4a")).toBe(false);
    expect(sharesPrimaryRecording(doc, null)).toBe(false);
  });
});

describe("sentence alternation", () => {
  it("uses each narration's clock and lets either language lead", () => {
    const doc = parseBilingualDocument(fixture);
    expect(sentenceSequence(doc, "source").map((clip) => [clip?.side, clip?.startMs, clip?.endMs])).toEqual([
      ["source", 200, 1800], ["target", 2500, 4000],
    ]);
    expect(sentenceSequence(doc, "target").map((clip) => clip?.side)).toEqual(["target", "source"]);
    expect(sentenceStartIndex(doc, "source", 0)).toBe(0);
    expect(sentenceStartIndex(doc, "target", 3000)).toBe(0);
    expect(sentenceStartIndex(doc, "source", 2000)).toBe(-1);
  });
  it("retains a stop for uncertain or untimed pairs instead of skipping them", () => {
    const doc = parseBilingualDocument(fixture), pair = doc.pairs[0];
    if (!pair) throw new Error("Missing fixture pair");
    pair.status = "uncertain";
    expect(sentenceSequence(doc, "source")).toEqual([null, null]);
    pair.status = "matched";
    doc.target.narration = null;
    expect(sentenceSequence(doc, "source")).toEqual([null, null]);
  });
  it("moves to the next pair after both versions, never back to the first pair", () => {
    const doc = parseBilingualDocument(fixture), pair = doc.pairs[0];
    if (!pair) throw new Error("Missing fixture pair");
    doc.pairs.push({ ...pair, id: "p2" });
    expect(sentenceSequence(doc, "source").map((clip) => [clip?.pairId, clip?.side])).toEqual([
      [pair.id, "source"], [pair.id, "target"], ["p2", "source"], ["p2", "target"],
    ]);
  });
});
