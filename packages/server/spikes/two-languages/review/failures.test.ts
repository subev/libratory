import { beforeEach, expect, test, vi } from "vitest";
import { align } from "../align.mts";
import { linkByIds } from "../links-ids.mts";
import type { LinkPair } from "../links.mts";
import { timeline, spanTiming } from "../timing.mts";
import { tokenize } from "../tokens.mts";

const mocks = vi.hoisted(() => ({ answer: "", finishReason: "stop", vectors: [] as number[][] }));
vi.mock("../../../src/lib/embeddings.ts", () => ({ embedTexts: async () => mocks.vectors }));
vi.mock("../../../src/lib/llm.ts", () => ({ resolveLlm: async () => ({ model: {} }) }));
vi.mock("ai", () => ({ generateText: async () => ({ text: mocks.answer, usage: {}, finishReason: mocks.finishReason }) }));

const whole = (text: string) => ({ start: 0, end: text.length });
const pair = (id: string, s: string, sText: string, t: string, tText: string, sLocale = "en", tLocale = "bg"): LinkPair => {
  const sOff = sText.indexOf(s), tOff = tText.indexOf(t);
  const sSpan = { start: sOff, end: sOff + s.length }, tSpan = { start: tOff, end: tOff + t.length };
  return { id, s: sSpan, t: tSpan, sTokens: tokenize(sText, sSpan, sLocale), tTokens: tokenize(tText, tSpan, tLocale) };
};
const one = (s: string, t: string, sLocale = "en", tLocale = "bg") =>
  linkByIds([pair("p1", s, s, t, t, sLocale, tLocale)], s, t, { from: "English", to: "Bulgarian" });
const slice = (text: string, p: LinkPair, side: "s" | "t", ids: number[]) =>
  ids.map((id) => { const tok = (side === "s" ? p.sTokens : p.tTokens)[id - 1]!; return text.slice(tok.start, tok.end); });

beforeEach(() => { mocks.answer = ""; mocks.finishReason = "stop"; mocks.vectors = []; });

// Sentence alignment: the path always completes, so the statuses must say which steps to trust

test("an unrelated sentence among good pairs is uncertain, not a translation", async () => {
  const e = (k: number) => Array.from({ length: 8 }, (_, d) => (d === k ? 1 : 0));
  const src = Array.from({ length: 6 }, (_, k) => ({ start: k * 3, end: k * 3 + 2 }));
  // five translations match their source; the sixth target points somewhere else entirely
  mocks.vectors = [...[0, 1, 2, 3, 4, 5].map(e), ...[0, 1, 2, 3, 4, 7].map(e)];
  const pairs = await align(src, "x. ".repeat(6), src, "y. ".repeat(6));
  expect(pairs.map((p) => p.status)).toEqual(["matched", "matched", "matched", "matched", "matched", "uncertain"]);
});

test("a sentence the translation dropped is reported unpaired, not merged into its neighbour", async () => {
  mocks.vectors = [[1, 0], [0, 1], [1, 0]];
  const pairs = await align([{ start: 0, end: 2 }, { start: 3, end: 5 }], "A. B.", [whole("A.")], "A.");
  expect(pairs.map((p) => [p.status, p.s, p.t])).toEqual([
    ["matched", { start: 0, end: 2 }, whole("A.")],
    ["source-only", { start: 3, end: 5 }, null],
  ]);
});

// Word links by token id: occurrences, sharing, scripts and case are the tokenizer's, not a search's

test("the second of two identical words is addressed by its own id", async () => {
  const s = "I saw her mother with her.", t = "Видях майка ѝ с нея.";
  mocks.answer = "p1: 6 = 4";
  const run = await one(s, t);
  expect(slice(s, pair("p1", s, s, t, t), "s", run.links[0]!.s)).toEqual(["her"]);
  expect(run.links[0]!.s).toEqual([6]);
});

test("two source words may share one target word", async () => {
  mocks.answer = "p1: 2 = 2\np1: 3 = 2";
  const run = await one("He fell asleep.", "Той заспа.");
  expect(run.links).toEqual([{ pairId: "p1", s: [2], t: [2] }, { pairId: "p1", s: [3], t: [2] }]);
});

test("a discontinuous expression is one link", async () => {
  mocks.answer = "p1: 2 5 = 2";
  const run = await one("They turned the lights off.", "Те изключиха лампите.");
  expect(run.links).toEqual([{ pairId: "p1", s: [2, 5], t: [2] }]);
});

test("an unspaced script is split into words", async () => {
  const s = "I like cats.", t = "我喜欢猫。";
  mocks.answer = "p1: 3 = 3";
  const run = await one(s, t, "en", "zh");
  expect(slice(t, pair("p1", s, s, t, t, "en", "zh"), "t", run.links[0]!.t)).toEqual(["猫"]);
});

test("token ranges index the original text, whatever case mapping would do to it", () => {
  const text = "İ CAT";
  expect(tokenize(text, whole(text), "en").map((tok) => text.slice(tok.start, tok.end))).toEqual(["İ", "CAT"]);
});

test("a pair the answer never mentions is missing, and a pair outside the batch is invalid", async () => {
  mocks.answer = "p1: 1 = 1\np9: 1 = 1\nThe rest could not be processed.";
  const s = "cat dog", t = "котка куче";
  const run = await linkByIds([
    { id: "p1", s: { start: 0, end: 3 }, t: { start: 0, end: 5 }, sTokens: tokenize(s, { start: 0, end: 3 }, "en"), tTokens: tokenize(t, { start: 0, end: 5 }, "bg") },
    { id: "p2", s: { start: 4, end: 7 }, t: { start: 6, end: 10 }, sTokens: tokenize(s, { start: 4, end: 7 }, "en"), tTokens: tokenize(t, { start: 6, end: 10 }, "bg") },
  ], s, t, { from: "English", to: "Bulgarian" });
  expect(run.links).toHaveLength(1);
  expect(run.missing).toEqual(["p2"]);
  expect(run.invalid).toEqual(["p9: 1 = 1"]);
});

test("an explicit empty answer counts as answered", async () => {
  mocks.answer = "p1: -";
  const run = await one("Hm.", "Хм.");
  expect(run.answered).toEqual(["p1"]);
  expect(run.missing).toEqual([]);
});

test("a no-counterpart answer must identify real source tokens", async () => {
  mocks.answer = "p1: 999 = -";
  const run = await one("Hello.", "Здравей.");
  expect(run.answered).toEqual([]);
  expect(run.missing).toEqual(["p1"]);
  expect(run.invalid).toEqual([mocks.answer]);
});

test("truncated output is incomplete even if every pair has a valid line", async () => {
  mocks.answer = "p1: 1 = 1";
  mocks.finishReason = "length";
  const run = await one("Hello.", "Здравей.");
  expect(run.answered).toEqual([]);
  expect(run.missing).toEqual(["p1"]);
  expect(run.links).toEqual([]);
  expect(run.batches[0]?.error).toContain("length");
});

// Timing: every edge names how it was obtained

test("an edge with no reported word is interpolated, even when its chunk has other words", () => {
  const text = "One two three.";
  const tl = timeline(text, { version: 2, totalMs: 3000, chunks: [{ text, startMs: 0, endMs: 3000, words: [{ text: "One", after: " ", startMs: 100, endMs: 400 }] }] });
  expect(spanTiming(tl, { start: 4, end: 7 }).start.method).toBe("interpolated");
});

test("a sentence's end is its last word's end, not the silence after it", () => {
  const text = "Hello.";
  const tl = timeline(text, { version: 2, totalMs: 2000, chunks: [{ text, startMs: 0, endMs: 2000, words: [{ text: "Hello.", after: "", startMs: 100, endMs: 500 }] }] });
  expect(spanTiming(tl, whole(text))).toEqual({ start: { ms: 100, method: "provider-word" }, end: { ms: 500, method: "provider-word" } });
});

test("a chunk's own edges are reported as chunk boundaries", () => {
  const text = "Hello.";
  const tl = timeline(text, { version: 1, totalMs: 2000, chunks: [{ text, startMs: 0, endMs: 2000 }] });
  expect(spanTiming(tl, whole(text))).toEqual({ start: { ms: 0, method: "chunk-boundary" }, end: { ms: 2000, method: "chunk-boundary" } });
});

test("text the audio could not be matched to is unavailable, never interpolated across", () => {
  const text = "Heard. Unheard.";
  const tl = timeline(text, { version: 1, totalMs: 2000, chunks: [{ text: "Heard.", startMs: 0, endMs: 1000 }, { text: "Something else.", startMs: 1000, endMs: 2000 }] });
  expect(spanTiming(tl, { start: 7, end: 15 }).start).toEqual({ ms: null, method: "unavailable" });
});
