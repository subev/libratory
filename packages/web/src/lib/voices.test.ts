import { describe, expect, it } from "vitest";

import { staticVoices, voiceMissingEngine, type Voice } from "./voices.ts";

describe("voiceMissingEngine", () => {
  const bgtts = staticVoices.find((v) => v.id === "bg-bgtts:female") as Voice;

  it("names the setup step for an engine whose env is absent, and nothing while unknown", () => {
    expect(voiceMissingEngine(bgtts, { piper: true, bgtts: false })).toMatch(/setup --bgtts/);
    expect(voiceMissingEngine(bgtts, { piper: true, bgtts: true })).toBeNull();
    expect(voiceMissingEngine(bgtts, undefined)).toBeNull();
    expect(voiceMissingEngine(staticVoices.find((v) => v.id === "bg-mms:bul") as Voice, { bgtts: false })).toBeNull();
  });
});
