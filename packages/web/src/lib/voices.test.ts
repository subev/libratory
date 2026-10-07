import { describe, expect, it } from "vitest";

import { getVoiceLabel, staticVoices, voiceMissingEngine, type Voice } from "./voices.ts";

describe("voiceMissingEngine", () => {
  const bgtts = staticVoices.find((v) => v.id === "bg-bgtts:female") as Voice;
  const source = (installed: Record<string, boolean>) => ({ installed, runtime: "source" as const });

  it("names the setup step for an engine whose env is absent, and nothing while unknown", () => {
    expect(voiceMissingEngine(bgtts, source({ piper: true, bgtts: false }))).toMatch(/setup --bgtts/);
    expect(voiceMissingEngine(bgtts, source({ piper: true, bgtts: true }))).toBeNull();
    expect(voiceMissingEngine(bgtts, undefined)).toBeNull();
    expect(voiceMissingEngine(staticVoices.find((v) => v.id === "bg-mms:bul") as Voice, source({ bgtts: false }))).toBeNull();
  });

  // A packaged build has no setup script to run, so it must not tell anyone to run one
  it("says which build lacks it instead of naming a command a packaged app cannot run", () => {
    expect(voiceMissingEngine(bgtts, { installed: { bgtts: false }, runtime: "desktop" })).toBe("Not in the desktop app yet");
    expect(voiceMissingEngine(bgtts, { installed: { bgtts: false }, runtime: "docker" })).toBe("Not in the Docker image yet");
  });

  it("points at the download when the app can build the engine itself, and says so while it does", () => {
    const install = (installing: boolean) => ({ bgtts: { installable: true, installing } });
    expect(voiceMissingEngine(bgtts, { installed: { bgtts: false }, runtime: "desktop", install: install(false) })).toMatch(/Download and set up/);
    expect(voiceMissingEngine(bgtts, { installed: { bgtts: false }, runtime: "desktop", install: install(true) })).toMatch(/^Setting up/);
    expect(voiceMissingEngine(bgtts, { installed: { bgtts: true }, runtime: "desktop", install: install(false) })).toBeNull();
  });
});

describe("getVoiceLabel", () => {
  it("names a voice, and a retired one by what it was rather than its id", () => {
    expect(getVoiceLabel("bg-bgtts:male2")).toBe("BgTTS-38M male 2 (M)");
    expect(getVoiceLabel("bg-mlx:narrator")).toBe("BG-TTS V5 (retired)");
    expect(getVoiceLabel("kugel:default")).toBe("KugelAudio (retired)");
  });
});
