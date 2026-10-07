import { describe, expect, it } from "vitest";
import { bilingualChapterState } from "./bilingual-chapter-state.ts";
import { textRevision } from "./bilingual-format.ts";
import type { BilingualJob, PairArtifact } from "./bilingual-preparation.ts";

const SOURCE = "Go now. Go back.";
const TARGET = "Geh jetzt. Geh zurück.";
const done = { kind: "translation", status: "done" } as const;

function pairs(source = SOURCE): PairArtifact {
  const lane = (text: string, language: string) => ({ id: language, language, text, textRevision: textRevision(text), tokens: [] });
  return {
    revision: "r1", aligner: "test", tokenizer: "test", source: lane(source, "en"), target: lane(TARGET, "de"),
    pairs: [
      { id: "p1", status: "matched", source: [0, 7], target: [0, 10], links: [], linksStatus: "unavailable" },
      { id: "p2", status: "matched", source: [8, 16], target: [11, 22], links: [], linksStatus: "unavailable" },
      { id: "p3", status: "source-only", source: [16, 16], target: [22, 22], links: [], linksStatus: "unavailable" },
    ],
  };
}

const job = (status: BilingualJob["status"], over: Partial<BilingualJob> = {}): BilingualJob =>
  ({ status, runId: "x", model: null, done: 0, total: 0, error: null, updatedAt: "", ...over });

const state = (row: Parameters<typeof bilingualChapterState>[0]["row"], variant: { kind: string; status: "pending" | "translating" | "done" | "failed" | "suspended" } | null = done) =>
  bilingualChapterState({ variant, source: SOURCE, target: TARGET, row });

describe("bilingualChapterState", () => {
  it("says what is missing before anything can be paired", () => {
    expect(state(null, null).step).toBe("no-translation");
    expect(state(null, { kind: "transform", status: "done" }).step).toBe("no-translation");
    expect(state(null, { kind: "translation", status: "translating" }).step).toBe("translating");
    expect(state(null, { kind: "translation", status: "pending" }).step).toBe("translating");
    // A stopped run is not running: it read "Translating" for weeks on a book nothing was translating
    expect(state(null, { kind: "translation", status: "suspended" }).step).toBe("translation-stopped");
    expect(state(null, { kind: "translation", status: "failed" }).step).toBe("translation-failed");
    expect(bilingualChapterState({ variant: done, source: SOURCE, target: "", row: null }).step).toBe("no-text");
  });

  it("tells never paired from paired before the text changed", () => {
    expect(state(null).step).toBe("unpaired");
    expect(state({ pairs: pairs("Go later."), links: null, pairJob: job("done"), linkJob: null }).step).toBe("outdated");
  });

  it("reports a running step with its progress and a failed pairing with its message", () => {
    expect(state({ pairs: null, links: null, pairJob: job("running", { done: 3, total: 10 }), linkJob: null }))
      .toMatchObject({ step: "pairing", progress: { done: 3, total: 10 } });
    expect(state({ pairs: null, links: null, pairJob: job("failed", { error: "model missing" }), linkJob: null }))
      .toMatchObject({ step: "pair-failed", error: "model missing" });
  });

  it("counts matched groups and their word links, and is done only when every match is linked", () => {
    const paired = state({ pairs: pairs(), links: { pairRevision: "r1", promptVersion: "v", byPair: { p1: [] }, batches: [] }, pairJob: job("done"), linkJob: job("failed", { error: "quota" }) });
    expect(paired).toMatchObject({ step: "paired", pairs: 3, matched: 2, linked: 1, error: "quota" });
    const linked = state({ pairs: pairs(), links: { pairRevision: "r1", promptVersion: "v", byPair: { p1: [], p2: [] }, batches: [] }, pairJob: job("done"), linkJob: job("done") });
    expect(linked).toMatchObject({ step: "linked", linked: 2, error: null });
  });

  it("ignores links made for an earlier pairing", () => {
    const stale = state({ pairs: pairs(), links: { pairRevision: "r0", promptVersion: "v", byPair: { p1: [], p2: [] }, batches: [] }, pairJob: job("done"), linkJob: null });
    expect(stale).toMatchObject({ step: "paired", linked: 0 });
  });
});
