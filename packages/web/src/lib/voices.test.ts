import { describe, expect, it } from "vitest";

import { getVoiceById, staticVoices, voiceBlockedByMissingMlx, voiceMissingEngine, type Voice } from "./voices.ts";

const kokoro = getVoiceById("kokoro:af_heart")!;
const kugel = getVoiceById("kugel:default")!;

describe("voiceBlockedByMissingMlx", () => {
  it("blocks an MLX narrator when the probe says there is no MLX", () => {
    expect(voiceBlockedByMissingMlx(kugel, false)).toBe(true);
  });

  it("leaves every other engine alone — they fall back to the CPU", () => {
    expect(voiceBlockedByMissingMlx(kokoro, false)).toBe(false);
  });

  // Two voices flickering greyed-out on every page load while the probe runs is worse than the
  // rare case of offering a voice that then fails
  it("assumes available while the probe has not answered", () => {
    expect(voiceBlockedByMissingMlx(kugel, undefined)).toBe(false);
  });

  it("marks exactly the two Metal-only narrators", () => {
    const flagged = staticVoices.filter((v: Voice) => v.requiresMlx).map((v) => v.id).sort();
    expect(flagged).toEqual(["bg-mlx:narrator", "kugel:default"]);
  });
});

describe("voiceMissingEngine", () => {
  const bgtts = staticVoices.find((v) => v.id === "bg-bgtts:female") as Voice;

  it("names the setup step for an engine whose env is absent, and nothing while unknown", () => {
    expect(voiceMissingEngine(bgtts, { piper: true, bgtts: false })).toMatch(/setup --bgtts/);
    expect(voiceMissingEngine(bgtts, { piper: true, bgtts: true })).toBeNull();
    expect(voiceMissingEngine(bgtts, undefined)).toBeNull();
    expect(voiceMissingEngine(staticVoices.find((v) => v.id === "bg-mms:bul") as Voice, { bgtts: false })).toBeNull();
  });
});
