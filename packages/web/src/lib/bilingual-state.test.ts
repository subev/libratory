import { describe, expect, it } from "vitest";
import { bilingualShort, describeBilingual, type BilingualChapterState } from "./bilingual-state.ts";

const state = (over: Partial<BilingualChapterState>): BilingualChapterState =>
  ({ step: "linked", pairs: 22, matched: 21, linked: 21, progress: null, error: null, ...over });

describe("describeBilingual", () => {
  it("counts sentence pairs and names the ones without a match apart", () => {
    expect(describeBilingual(state({}), "Bulgarian")).toBe("21 sentence pairs, 1 without a match · words linked in all of them");
    expect(describeBilingual(state({ step: "paired", pairs: 21, linked: 5 }), "Bulgarian")).toBe("21 sentence pairs · words linked in 5 of them");
  });

  it("names the translation a chapter is waiting for", () => {
    expect(describeBilingual(state({ step: "no-translation" }), "Bulgarian")).toBe("No Bulgarian translation yet — translate this chapter first");
  });
});

describe("bilingualShort", () => {
  it("shows progress while a step runs and a failure over a partial pairing", () => {
    expect(bilingualShort(state({ step: "pairing", progress: { done: 3, total: 10 } })).label).toBe("Pairing 3/10");
    expect(bilingualShort(state({ step: "paired", error: "quota" }))).toEqual({ label: "Linking failed", tone: "danger" });
  });
});
