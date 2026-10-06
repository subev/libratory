import { describe, expect, it } from "vitest";

import { getVoiceLabel, staticVoices, voiceMissingEngine, type Voice } from "./voices.ts";

describe("voiceMissingEngine", () => {
  const bgtts = staticVoices.find((v) => v.id === "bg-bgtts:female") as Voice;

  it("names the setup step for an engine whose env is absent, and nothing while unknown", () => {
    expect(voiceMissingEngine(bgtts, { piper: true, bgtts: false })).toMatch(/setup --bgtts/);
    expect(voiceMissingEngine(bgtts, { piper: true, bgtts: true })).toBeNull();
    expect(voiceMissingEngine(bgtts, undefined)).toBeNull();
    expect(voiceMissingEngine(staticVoices.find((v) => v.id === "bg-mms:bul") as Voice, { bgtts: false })).toBeNull();
  });
});

describe("getVoiceLabel", () => {
  it("names a voice, and a retired one by what it was rather than its id", () => {
    expect(getVoiceLabel("bg-bgtts:male2")).toBe("BgTTS-38M male 2 (M)");
    expect(getVoiceLabel("bg-mlx:narrator")).toBe("BG-TTS V5 (retired)");
    expect(getVoiceLabel("kugel:default")).toBe("KugelAudio (retired)");
  });
});
