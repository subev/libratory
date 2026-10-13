import { describe, expect, it, vi } from "vitest";
import { alignVectors } from "./bilingual-align.ts";
import { sentences, tokenize } from "./bilingual-segment.ts";
import { spanTiming, timeline } from "./bilingual-timing.ts";
import { linkBatches, linkPrompt, parseWordLinks, parseWordLinkBatch, requestWordLinks, wordLinkSystem } from "./bilingual-links.ts";
import { textRevision } from "./bilingual-format.ts";
import type { PairArtifact } from "./bilingual-preparation.ts";
import { bilingualLinkSemantics } from "./fixtures/bilingual-link-semantics.ts";

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

function semanticArtifact(source: string, target: string): PairArtifact {
  const lane = (text: string, language: string) => ({ id: language, language, text, textRevision: textRevision(text),
    tokens: tokenize(text, { start: 0, end: text.length }, language).map((t) => ({ id: t.id, range: [t.start, t.end] as [number, number] })) });
  return { revision: "semantic-fixture", aligner: "fixture", tokenizer: "intl-segmenter-word/1", source: lane(source, "en"), target: lane(target, "fr"),
    pairs: [{ id: "p1", status: "matched", source: [0, source.length], target: [0, target.length], links: [], linksStatus: "unavailable" }] };
}

function phraseIds(lane: PairArtifact["source"], phrase: string, occurrence = 0): number[] {
  const matches = lane.tokens.flatMap((token) => {
    const start = token.range[0], end = start + phrase.length;
    if (!lane.text.startsWith(phrase, start)) return [];
    const tokens = lane.tokens.filter((t) => t.range[0] >= start && t.range[1] <= end);
    return tokens.at(-1)?.range[1] === end ? [tokens.map((t) => t.id)] : [];
  });
  const ids = matches[occurrence];
  if (!ids?.length) throw new Error(`Missing occurrence ${occurrence} of ${phrase}`);
  return ids;
}

describe("word-link semantic fixtures and prompt contract", () => {
  it.each(bilingualLinkSemantics)("carries exact local token text and accepts curated groups: $name", (entry) => {
    const data = semanticArtifact(entry.source, entry.target), prompt = linkPrompt(data, data.pairs);
    for (const lane of [data.source, data.target]) {
      expect(prompt).toContain(`${lane.language}: ${lane.text}`);
      expect(prompt).toContain(lane.tokens.map((t) => `${t.id}:${lane.text.slice(...t.range)}`).join(" "));
    }
    const expected = entry.groups.map((g) => ({ source: phraseIds(data.source, g.source, g.sourceOccurrence), target: phraseIds(data.target, g.target, g.targetOccurrence) }));
    const raw = expected.map((g) => `p1: ${g.source.join(" ")} = ${g.target.join(" ")}`).join("\n");
    expect(parseWordLinkBatch(raw, data, data.pairs)).toEqual({ links: { p1: expected }, error: null });
  });

  it("keeps persisted occurrence IDs when requesting a later pair alone", () => {
    const data = fixture(), pair = data.pairs[1];
    if (!pair) throw new Error("Missing pair");
    expect(linkPrompt(data, [pair])).toBe("p2\nen: Go back.\n  3:Go 4:back\nde: Geh zurück.\n  3:Geh 4:zurück");
    const system = wordLinkSystem("English", "French");
    expect(system).toContain("do not recount words or restart numbering");
    expect(system).toContain("Repeated words have distinct occurrence IDs");
    expect(system).toContain("one contracted token may correspond to several tokens");
    expect(system).toContain("I corresponds to me and you to Tu");
    expect(system).toContain("including required prepositions and negation");
    expect(system).toContain("Answer with token numbers only");
  });

  it("does not mistake valid IDs for a semantic guarantee", () => {
    const data = semanticArtifact("I miss you.", "Tu me manques.");
    const raw = `p1: ${phraseIds(data.source, "I").join(" ")} = ${phraseIds(data.target, "Tu").join(" ")}`;
    expect(parseWordLinkBatch(raw, data, data.pairs).error).toBeNull();
  });
});

describe("production bilingual preparation", () => {
  it("yields to the event loop and stops a large alignment when ownership is lost", async () => {
    const spans = Array.from({ length: 200 }, (_, i) => ({ start: i * 10, end: i * 10 + 9 }));
    const vectors = Array.from({ length: 400 }, () => Array.from({ length: 1024 }, () => 1 / 32));
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    try {
      const result = await alignVectors(spans, spans, vectors, async () => !timerRan);
      expect(timerRan).toBe(true);
      expect(result).toBeNull();
    } finally { clearTimeout(timer); }
  });
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
  it("preserves complete valid pairs while rejecting every link in an invalid pair", () => {
    const data = fixture();
    const parsed = parseWordLinkBatch("p1: 1 = 1\np2: 3 = 3\np2: 2 = 4", data, data.pairs);
    expect(parsed.links).toEqual({ p1: [{ source: [1], target: [1] }] });
    expect(parsed.error).toContain("Saved 1/2 sentence groups");
    expect(parsed.error).toContain("p2: Token 2 is not in the source sentence");
    expect(linkBatches(data, parsed.links).flat().map((p) => p.id)).toEqual(["p2"]);
    expect(parseWordLinkBatch("p1: -", data, data.pairs).links).toEqual({ p1: [] });
    expect(() => parseWordLinkBatch("p1: -\np3: -", data, data.pairs)).toThrow("unknown pair");
  });
  it("ignores unlinked declarations without interpreting their lane, but validates actual links", () => {
    const data = fixture();
    data.source.tokens = data.source.tokens.map((t) => ({ ...t, id: t.id + 40 }));
    data.target.tokens = data.target.tokens.map((t) => ({ ...t, id: t.id + 30 }));
    expect(parseWordLinks("p1: 41 = 31\np1: 32 = -\np1: - = 42\np2: -", data, data.pairs))
      .toEqual({ p1: [{ source: [41], target: [31] }], p2: [] });
    for (const raw of ["p1: 32 = 31\np2: -", "p1: 41 = 42\np2: -", "p1: nonsense = -\np2: -", "p3: 32 = -\np2: -"]) {
      expect(() => parseWordLinks(raw, data, data.pairs)).toThrow();
    }
  });
  it("rejects a truncated but otherwise parseable response without retrying", async () => {
    const data = fixture();
    generate.mockResolvedValueOnce({ text: "p1: -\np2: -", finishReason: "length", usage: { inputTokens: 20, outputTokens: 10 } });
    const result = await requestWordLinks(data, data.pairs, "test");
    expect(result.links).toBeNull();
    expect(result.record).toMatchObject({ promptVersion: "token-ids/2", raw: "p1: -\np2: -", error: "Incomplete word-link response: length" });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0,
      prompt: linkPrompt(data, data.pairs), system: wordLinkSystem(data.source.language, data.target.language) }));
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
  it("leaves a deleted translation sentence one-sided instead of absorbing it", async () => {
    const src = [{ start: 0, end: 10 }, { start: 11, end: 21 }, { start: 22, end: 32 }];
    const tgt = [{ start: 0, end: 10 }, { start: 11, end: 21 }];
    const pairs = await alignVectors(src, tgt, [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1]]);
    expect(pairs?.map((p) => p.status)).toEqual(["matched", "source-only", "matched"]);
    expect(pairs?.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    await expect(alignVectors(src, tgt, [[NaN]])).rejects.toThrow("Invalid sentence embedding");
  });
  it("ends a passage that closes its chunk with the chunk, not at the last word's reported end", () => {
    const text = "Hello world.";
    const tl = timeline(text, { version: 2, totalMs: 1500, chunks: [{ text, startMs: 0, endMs: 1500,
      words: [{ text: "Hello", after: " ", startMs: 100, endMs: 400 }, { text: "world", after: ".", startMs: 500, endMs: 1000 }] }] });
    expect(spanTiming(tl, { start: 0, end: text.length })).toEqual({ start: { ms: 100, method: "provider-word" }, end: { ms: 1500, method: "chunk-boundary" } });
  });
  it("ends a passage inside its chunk at its final provider word", () => {
    const text = "Hello. World.";
    const tl = timeline(text, { version: 2, totalMs: 1500, chunks: [{ text, startMs: 0, endMs: 1500,
      words: [{ text: "Hello.", after: " ", startMs: 100, endMs: 400 }, { text: "World.", after: "", startMs: 600, endMs: 1000 }] }] });
    expect(spanTiming(tl, { start: 0, end: 6 })).toEqual({ start: { ms: 100, method: "provider-word" }, end: { ms: 400, method: "provider-word" } });
  });
  it("does not interpolate through text missing from the recording", () => {
    const text = "Hello. Missing. Bye.";
    const tl = timeline(text, { version: 1, totalMs: 2000, chunks: [{ text: "Hello.", startMs: 0, endMs: 1000 }, { text: "Bye.", startMs: 1000, endMs: 2000 }] });
    expect(spanTiming(tl, { start: 7, end: 15 })).toEqual({ start: { ms: null, method: "unavailable" }, end: { ms: null, method: "unavailable" } });
  });
  it("leaves an unspoken separator between chunks untimed instead of reversing its edges", () => {
    const text = "Hello. . . . Bye.";
    const tl = timeline(text, { version: 2, totalMs: 2000, chunks: [
      { text: "Hello.", startMs: 0, endMs: 1000 },
      { text: "Bye.", startMs: 1000, endMs: 2000,
        words: [{ text: "Bye", after: ".", startMs: 1040, endMs: 1900 }] },
    ] });
    expect(spanTiming(tl, { start: 7, end: 12 })).toEqual({
      start: { ms: null, method: "unavailable" }, end: { ms: null, method: "unavailable" },
    });
  });
});
