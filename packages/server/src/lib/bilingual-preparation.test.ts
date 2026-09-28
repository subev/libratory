import { describe, expect, it, vi } from "vitest";
import { alignVectors } from "./bilingual-align.ts";
import { sentences, tokenize } from "./bilingual-segment.ts";
import { spanTiming, timeline } from "./bilingual-timing.ts";
import { linkBatches, parseWordLinks, requestWordLinks } from "./bilingual-links.ts";
import { textRevision } from "./bilingual-format.ts";
import type { PairArtifact } from "./bilingual-preparation.ts";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", () => ({ generateText: generate }));
vi.mock("./llm.ts", () => ({ resolveLlm: async () => ({ model: {}, def: {} }), callSettings: () => ({}) }));

function fixture(): PairArtifact {
  const lane = (text: string, language: string) => ({ id: language, language, text, textRevision: textRevision(text),
    tokens: tokenize(text, { start: 0, end: text.length }, language).map((t) => ({ id: t.id, range: [t.start, t.end] as [number, number] })) });
  return { revision: "pairs", aligner: "test", tokenizer: "test", source: lane("Go now. Go back.", "en"), target: lane("Geh jetzt. Geh zurück.", "de"),
    pairs: [
      { id: "p1", status: "matched", source: [0, 7], target: [0, 10], links: [], linksStatus: "unavailable" },
      { id: "p2", status: "matched", source: [8, 16], target: [11, 22], links: [], linksStatus: "unavailable" },
    ] };
}

describe("production bilingual preparation", () => {
  it("addresses repeated words by their persisted IDs, including reordered links", () => {
    const data = fixture();
    expect(parseWordLinks("p2: 4 = 4\np1: 2 = 2\np2: 3 = 3\np1: 1 = 1", data, data.pairs).p2)
      .toEqual([{ source: [4], target: [4] }, { source: [3], target: [3] }]);
  });
  it("rejects incomplete batches, foreign pair IDs, cross-pair tokens and extra prose", () => {
    const data = fixture();
    for (const raw of ["p1: 1 = 1", "p1: -\np3: -", "p1: 3 = 1\np2: -", "p1: -\np2: -\nDone!"]) {
      expect(() => parseWordLinks(raw, data, data.pairs)).toThrow();
    }
    expect(parseWordLinks("p1: 1 = -\np2: -", data, data.pairs)).toEqual({ p1: [], p2: [] });
  });
  it("resumes only unanswered matched pairs, including completed empty answers", () => {
    const data = fixture();
    expect(linkBatches(data, { p1: [] }).flat().map((p) => p.id)).toEqual(["p2"]);
  });
  it("rejects a truncated but otherwise parseable response without retrying", async () => {
    const data = fixture();
    generate.mockResolvedValueOnce({ text: "p1: -\np2: -", finishReason: "length", usage: { inputTokens: 20, outputTokens: 10 } });
    const result = await requestWordLinks(data, data.pairs, "test");
    expect(result.links).toBeNull();
    expect(result.record).toMatchObject({ raw: "p1: -\np2: -", error: "Incomplete word-link response: length" });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("preserves Hebrew combining marks, German compounds and unspaced Chinese tokens", () => {
    for (const [language, text] of [["he", "שָׁלוֹם עולם."], ["de", "Donaudampfschiff fährt."], ["zh", "你好世界。再见！"]]) {
      if (!text || !language) throw new Error("missing fixture");
      const bounds = new Set([text.length, ...Array.from(new Intl.Segmenter(language, { granularity: "grapheme" }).segment(text), (s) => s.index)]);
      const tokens = tokenize(text, { start: 0, end: text.length }, language);
      expect(tokens.length).toBeGreaterThan(1);
      expect(tokens.every((t) => bounds.has(t.start) && bounds.has(t.end))).toBe(true);
      expect(sentences(text, language).length).toBeGreaterThan(0);
    }
  });
  it("leaves a deleted translation sentence one-sided instead of absorbing it", () => {
    const src = [{ start: 0, end: 10 }, { start: 11, end: 21 }, { start: 22, end: 32 }];
    const tgt = [{ start: 0, end: 10 }, { start: 11, end: 21 }];
    const pairs = alignVectors(src, tgt, [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1]]);
    expect(pairs.map((p) => p.status)).toEqual(["matched", "source-only", "matched"]);
    expect(pairs.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(() => alignVectors(src, tgt, [[NaN]])).toThrow("Invalid sentence embedding");
  });
  it("ends a passage at its final provider word, excluding trailing silence", () => {
    const text = "Hello world.";
    const tl = timeline(text, { version: 2, totalMs: 1500, chunks: [{ text, startMs: 0, endMs: 1500,
      words: [{ text: "Hello", after: " ", startMs: 100, endMs: 400 }, { text: "world", after: ".", startMs: 500, endMs: 1000 }] }] });
    expect(spanTiming(tl, { start: 0, end: text.length })).toEqual({ start: { ms: 100, method: "provider-word" }, end: { ms: 1000, method: "provider-word" } });
  });
  it("does not interpolate through text missing from the recording", () => {
    const text = "Hello. Missing. Bye.";
    const tl = timeline(text, { version: 1, totalMs: 2000, chunks: [{ text: "Hello.", startMs: 0, endMs: 1000 }, { text: "Bye.", startMs: 1000, endMs: 2000 }] });
    expect(spanTiming(tl, { start: 7, end: 15 })).toEqual({ start: { ms: null, method: "unavailable" }, end: { ms: null, method: "unavailable" } });
  });
});
