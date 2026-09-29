import { describe, expect, it } from "vitest";
import { voiceHasWordTiming } from "./voice-catalog.ts";

describe("voiceHasWordTiming", () => {
  it("names the engines that time words and the one that only does so in English", () => {
    expect(voiceHasWordTiming("kokoro:af_heart")).toBe(true);
    expect(voiceHasWordTiming("kokoro:ef_dora")).toBe(false);
    expect(voiceHasWordTiming("kokoro:af_heart", "es")).toBe(false);
    expect(voiceHasWordTiming("cartesia:fcbecbcc-0cef-4615-8b5a-712fe1b39dd0", "bg")).toBe(true);
    expect(voiceHasWordTiming("elevenlabs:JBFqnCBsd6RMkjVDRZzb", "en")).toBe(true);
    expect(voiceHasWordTiming("bg-mlx:narrator", "bg")).toBe(false);
    expect(voiceHasWordTiming("bg-mms:bul", "bg")).toBe(false);
    expect(voiceHasWordTiming("say:daria", "bg")).toBe(false);
    expect(voiceHasWordTiming("pocket:en_female", "en")).toBe(false);
    expect(voiceHasWordTiming("kugel:default", "multi")).toBe(false);
  });
});
