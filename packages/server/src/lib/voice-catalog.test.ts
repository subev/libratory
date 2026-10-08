import { describe, expect, it } from "vitest";
import { clampSpeed, elevenlabsVoiceToEntry, speedRangeFor, voiceCoversLanguage, voiceHasWordTiming, voiceIsForeignIn } from "./voice-catalog.ts";

describe("voiceHasWordTiming", () => {
  it("names the engines that time words, and Kokoro everywhere but the languages written without spaces", () => {
    expect(voiceHasWordTiming("kokoro:af_heart")).toBe(true);
    expect(voiceHasWordTiming("kokoro:ef_dora")).toBe(true);
    expect(voiceHasWordTiming("kokoro:ff_siwis", "fr")).toBe(true);
    expect(voiceHasWordTiming("kokoro:zf_xiaobei")).toBe(false);
    expect(voiceHasWordTiming("cartesia:fcbecbcc-0cef-4615-8b5a-712fe1b39dd0", "bg")).toBe(true);
    expect(voiceHasWordTiming("elevenlabs:JBFqnCBsd6RMkjVDRZzb", "en")).toBe(true);
    // Its words are split at spaces, so a language written without them has none to time
    expect(voiceHasWordTiming("elevenlabs:JBFqnCBsd6RMkjVDRZzb", "ja")).toBe(false);
    expect(voiceHasWordTiming("bg-mlx:narrator", "bg")).toBe(false);
    expect(voiceHasWordTiming("bg-mms:bul", "bg")).toBe(false);
    expect(voiceHasWordTiming("bg-piper:dimitar", "bg")).toBe(true);
    expect(voiceHasWordTiming("bg-bgtts:female", "bg")).toBe(true);
    expect(voiceHasWordTiming("say:daria", "bg")).toBe(false);
    expect(voiceHasWordTiming("pocket:en_female", "en")).toBe(false);
  });
});

describe("an ElevenLabs voice's languages", () => {
  const george = elevenlabsVoiceToEntry({
    id: "JBFqnCBsd6RMkjVDRZzb",
    name: "George",
    language: "en",
    languages: ["en", "de"],
    reads: ["en", "de", "bg"],
    gender: "male",
    tagline: "",
  });

  it("is listed natively where it was verified and as a foreign reader where the model reads", () => {
    expect(voiceCoversLanguage(george, "en")).toBe(true);
    expect(voiceIsForeignIn(george, "en")).toBe(false);
    expect(voiceCoversLanguage(george, "de")).toBe(true);
    expect(voiceIsForeignIn(george, "de")).toBe(false);
    expect(voiceCoversLanguage(george, "bg")).toBe(true);
    expect(voiceIsForeignIn(george, "bg")).toBe(true);
    expect(voiceCoversLanguage(george, "vi")).toBe(false);
  });
});

describe("speed ranges", () => {
  it("narrows to what each cloud API accepts, and clamps the stored speed into it", () => {
    expect(speedRangeFor("elevenlabs:JBFqnCBsd6RMkjVDRZzb")).toEqual({ min: 0.7, max: 1.2 });
    expect(speedRangeFor("cartesia:abc")).toEqual({ min: 0.6, max: 1.5 });
    expect(speedRangeFor("kokoro:af_heart")).toEqual({ min: 0.5, max: 2 });
    expect(clampSpeed("elevenlabs:JBFqnCBsd6RMkjVDRZzb", 1.5)).toBe(1.2);
    expect(clampSpeed("bg-piper:dimitar", 1.5)).toBe(1.5);
  });
});
