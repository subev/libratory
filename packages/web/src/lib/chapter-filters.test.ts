import { describe, expect, it } from "vitest";
import {
  NO_FILTERS,
  STALE_VOICE,
  activeFilterCount,
  optionCounts,
  matchesFilters,
  parseBound,
  type ChapterFilters,
  type FilterableChapter,
} from "./chapter-filters.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const current = { voice: "af_heart", speed: 1 };

function chapter(over: Partial<FilterableChapter> = {}): FilterableChapter {
  return {
    status: "done",
    wordCount: 1200,
    durationMs: 8 * 60_000,
    sourceFileIndex: 0,
    audioPath: "/a.m4a",
    synthesizedWith: { voice: "af_heart", speed: 1, at: new Date(NOW - 2 * DAY).toISOString() },
    ...over,
  };
}

const keeps = (ch: FilterableChapter, f: Partial<ChapterFilters>) =>
  matchesFilters(ch, { ...NO_FILTERS, ...f }, { current, now: NOW });

describe("parseBound", () => {
  it("reads empty as no bound and 0 as a bound", () => {
    expect(parseBound("")).toBeNull();
    expect(parseBound("  ")).toBeNull();
    expect(parseBound("0")).toBe(0);
  });

  it("takes a decimal comma and refuses what is not a count", () => {
    expect(parseBound("1,5")).toBe(1.5);
    expect(parseBound("abc")).toBeNull();
    expect(parseBound("-3")).toBeNull();
  });
});

describe("matchesFilters", () => {
  it("keeps every chapter with no filters", () => {
    expect(keeps(chapter({ audioPath: null, durationMs: null, synthesizedWith: null }), {})).toBe(true);
  });

  it("treats max 0 words as only empty chapters, not as no limit", () => {
    expect(keeps(chapter(), { wordsMax: "0" })).toBe(false);
    expect(keeps(chapter({ wordCount: 0 }), { wordsMax: "0" })).toBe(true);
  });

  it("keeps a chapter matching any of the chosen statuses", () => {
    expect(keeps(chapter({ status: "failed" }), { statuses: ["failed", "suspended"] })).toBe(true);
    expect(keeps(chapter(), { statuses: ["failed", "suspended"] })).toBe(false);
  });

  it("filters length in minutes and drops chapters with no audio", () => {
    expect(keeps(chapter(), { minutesMin: "5", minutesMax: "10" })).toBe(true);
    expect(keeps(chapter(), { minutesMax: "7.5" })).toBe(false);
    expect(keeps(chapter({ audioPath: null, durationMs: null }), { minutesMax: "10" })).toBe(false);
  });

  it("finds audio made with another voice or speed", () => {
    expect(keeps(chapter(), { voice: STALE_VOICE })).toBe(false);
    expect(keeps(chapter({ synthesizedWith: { voice: "bm_george", speed: 1 } }), { voice: STALE_VOICE })).toBe(true);
    expect(keeps(chapter({ synthesizedWith: { voice: "af_heart", speed: 1.2 } }), { voice: STALE_VOICE })).toBe(true);
    // An engine with no speed control records none, and that is not a mismatch
    expect(keeps(chapter({ synthesizedWith: { voice: "af_heart", speed: null } }), { voice: STALE_VOICE })).toBe(false);
    // Audio from before the voice was recorded cannot be shown to match
    expect(keeps(chapter({ synthesizedWith: null }), { voice: STALE_VOICE })).toBe(true);
    expect(keeps(chapter({ audioPath: null, synthesizedWith: null }), { voice: STALE_VOICE })).toBe(false);
  });

  it("matches one voice only where there is audio made with it", () => {
    expect(keeps(chapter(), { voice: "af_heart" })).toBe(true);
    expect(keeps(chapter({ audioPath: null }), { voice: "af_heart" })).toBe(false);
  });

  it("dates by when the audio was made", () => {
    expect(keeps(chapter(), { age: "week" })).toBe(true);
    expect(keeps(chapter(), { age: "day" })).toBe(false);
    expect(keeps(chapter(), { age: "older-week" })).toBe(false);
    const old = chapter({ synthesizedWith: { voice: "af_heart", speed: 1, at: new Date(NOW - 40 * DAY).toISOString() } });
    expect(keeps(old, { age: "older-month" })).toBe(true);
    expect(keeps(chapter({ synthesizedWith: { voice: "af_heart" } }), { age: "older-week" })).toBe(false);
    expect(keeps(chapter({ audioPath: null }), { age: "week" })).toBe(false);
  });

  it("filters by source file", () => {
    expect(keeps(chapter({ sourceFileIndex: 1 }), { sourceFile: "1" })).toBe(true);
    expect(keeps(chapter(), { sourceFile: "1" })).toBe(false);
  });
});

describe("bilingual filter", () => {
  const at = (step: import("./bilingual-state.ts").BilingualStep) =>
    chapter({ bilingual: { step, pairs: 0, matched: 0, linked: 0, progress: null, error: null } });

  it("groups the steps the way a person acts on them", () => {
    expect(keeps(at("translating"), { bilingual: "needs-translation" })).toBe(true);
    expect(keeps(at("outdated"), { bilingual: "needs-pairing" })).toBe(true);
    expect(keeps(at("pairing"), { bilingual: "needs-pairing" })).toBe(true);
    expect(keeps(at("paired"), { bilingual: "readable" })).toBe(true);
    expect(keeps(at("linked"), { bilingual: "readable" })).toBe(true);
    expect(keeps(at("linked"), { bilingual: "needs-words" })).toBe(false);
    expect(keeps(at("linked"), { bilingual: "linked" })).toBe(true);
  });

  it("drops chapters with no state when a bilingual filter is set", () => {
    expect(keeps(chapter(), { bilingual: "linked" })).toBe(false);
    expect(keeps(chapter(), {})).toBe(true);
  });
});

describe("activeFilterCount", () => {
  it("counts a range once, and only bounds that parse", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, wordsMin: "10", wordsMax: "0" })).toBe(1);
    expect(activeFilterCount({ ...NO_FILTERS, wordsMax: "x" })).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, statuses: ["done"], voice: STALE_VOICE, age: "day" })).toBe(3);
  });
});

describe("optionCounts", () => {
  it("counts values, most common first", () => {
    expect(optionCounts(["a", "b", "b"], [])).toEqual([{ value: "b", count: 2 }, { value: "a", count: 1 }]);
  });

  it("keeps a chosen value no row has any more, so the filter can be undone", () => {
    expect(optionCounts(["done"], ["failed"])).toContainEqual({ value: "failed", count: 0 });
  });

  it("holds the given order whatever the counts", () => {
    const order = ["done", "failed", "pending"];
    expect(optionCounts(["pending", "pending", "done", "zzz"], [], order).map((o) => o.value)).toEqual(["done", "pending", "zzz"]);
  });
});
