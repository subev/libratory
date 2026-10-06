import { describe, expect, it, vi } from "vitest";

vi.mock("./cartesia.ts", () => ({
  cartesiaSynthesize: vi.fn(),
  CartesiaAbortedError: class CartesiaAbortedError extends Error {},
  findCartesiaVoice: vi.fn(async (id: string) =>
    id === "bg-voice-uuid" ? { id, name: "Ana", language: "bg", gender: "feminine", tagline: "" } : null,
  ),
}));

import { getPreviewTextForVoice, parseTtsVoice, previewFileBase, previewLanguageFor, voiceSupportsSpeed } from "./tts.ts";

describe("parseTtsVoice", () => {
  it("treats legacy Kokoro voice ids as Kokoro", () => {
    expect(parseTtsVoice("af_heart")).toEqual({
      engine: "kokoro",
      voice: "af_heart",
      raw: "af_heart",
    });
  });

  it("parses prefixed Kokoro voice ids", () => {
    expect(parseTtsVoice("kokoro:bf_emma")).toEqual({
      engine: "kokoro",
      voice: "bf_emma",
      raw: "kokoro:bf_emma",
    });
  });

  it("parses the Meta MMS Bulgarian voice", () => {
    expect(parseTtsVoice("bg-mms:bul")).toEqual({
      engine: "bg-mms",
      voice: "bul",
      raw: "bg-mms:bul",
    });
  });

  it("parses the BgTTS-38M and Piper Bulgarian voices", () => {
    expect(parseTtsVoice("bg-bgtts:male2")).toEqual({ engine: "bg-bgtts", voice: "male2", raw: "bg-bgtts:male2" });
    expect(parseTtsVoice("bg-piper:dimitar")).toEqual({ engine: "bg-piper", voice: "dimitar", raw: "bg-piper:dimitar" });
  });

  it("names a retired voice instead of calling it unsupported", () => {
    expect(() => parseTtsVoice("bg-mlx:narrator")).toThrow(/retired.*BgTTS-38M/);
    expect(() => parseTtsVoice("kugel:default")).toThrow(/KugelAudio was retired/);
  });

  it("parses Cartesia voice ids", () => {
    expect(parseTtsVoice("cartesia:a0e99841-438c-4a64-b679-ae501e7d6091")).toEqual({
      engine: "cartesia",
      voice: "a0e99841-438c-4a64-b679-ae501e7d6091",
      raw: "cartesia:a0e99841-438c-4a64-b679-ae501e7d6091",
    });
    expect(() => parseTtsVoice("cartesia:")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("cartesia:bad id")).toThrow(/unsupported voice/i);
  });

  it("parses macOS say voice slugs", () => {
    expect(parseTtsVoice("say:daria-enhanced")).toEqual({
      engine: "say",
      voice: "daria-enhanced",
      raw: "say:daria-enhanced",
    });
    expect(parseTtsVoice("say:eddy-english-united-states")).toEqual({
      engine: "say",
      voice: "eddy-english-united-states",
      raw: "say:eddy-english-united-states",
    });
  });

  it("parses Pocket TTS catalog voices", () => {
    expect(parseTtsVoice("pocket:alba")).toEqual({
      engine: "pocket",
      voice: "alba",
      raw: "pocket:alba",
    });
    expect(parseTtsVoice("pocket:bill_boerst")).toEqual({
      engine: "pocket",
      voice: "bill_boerst",
      raw: "pocket:bill_boerst",
    });
  });

  it("parses language-scoped Pocket TTS voices", () => {
    expect(parseTtsVoice("pocket:it:giovanni")).toEqual({
      engine: "pocket",
      voice: "it:giovanni",
      raw: "pocket:it:giovanni",
    });
    // bare ids predate languages and must keep resolving as English
    expect(parseTtsVoice("pocket:alba").voice).toBe("alba");
    expect(() => parseTtsVoice("pocket:xx:alba")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("pocket:it:nope")).toThrow(/unsupported voice/i);
  });

  it("parses cloned Pocket TTS voices", () => {
    expect(parseTtsVoice("pocket:custom:5e509238-95e1-41a0-9818-ec49f27e1bf3")).toEqual({
      engine: "pocket",
      voice: "custom:5e509238-95e1-41a0-9818-ec49f27e1bf3",
      raw: "pocket:custom:5e509238-95e1-41a0-9818-ec49f27e1bf3",
    });
    expect(() => parseTtsVoice("pocket:custom:not-a-uuid")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("pocket:custom:../../etc/passwd")).toThrow(/unsupported voice/i);
  });

  it("rejects unsupported or empty prefixed voice ids", () => {
    expect(() => parseTtsVoice("bg-mms:")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("bg-mms:other")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("bg-bgtts:../ref")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("bg-piper:")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("say:")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("say:Daria (Enhanced)")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("kokoro:")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("pocket:")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("pocket:not-a-catalog-voice")).toThrow(/unsupported voice/i);
  });

  it("rejects malformed legacy Kokoro voice ids", () => {
    expect(() => parseTtsVoice("")).toThrow(/unsupported voice/i);
    expect(() => parseTtsVoice("../../voice")).toThrow(/unsupported voice/i);
  });
});

describe("getPreviewTextForVoice", () => {
  it("returns Bulgarian sample text for the MMS voice", async () => {
    expect(await getPreviewTextForVoice("bg-mms:bul")).toMatch(/пролетна|утрин/i);
  });

  it("returns an English sample for Kokoro voices", async () => {
    expect(await getPreviewTextForVoice("kokoro:af_heart")).toMatch(/quick brown fox/i);
  });

  it("falls back to English for a say voice that is not installed", async () => {
    expect(await getPreviewTextForVoice("say:no-such-voice-installed")).toMatch(/quick brown fox/i);
  });

  it("returns an English sample for Pocket TTS voices", async () => {
    expect(await getPreviewTextForVoice("pocket:alba")).toMatch(/quick brown fox/i);
  });

  it("matches Cartesia preview text to the voice language", async () => {
    expect(await getPreviewTextForVoice("cartesia:bg-voice-uuid")).toMatch(/пролетна|утрин/i);
    expect(await getPreviewTextForVoice("cartesia:unknown-voice")).toMatch(/quick brown fox/i);
  });

  it("gives a metered engine one sentence rather than the paragraph", async () => {
    const preview = await getPreviewTextForVoice("elevenlabs:XB0fDUnXU5powFXDhCwa");
    expect(preview).toBe("The quick brown fox jumps over the lazy dog.");
  });
});

describe("voiceSupportsSpeed", () => {
  it("offers speed control on Piper, whose length scale works, and not on BgTTS-38M", () => {
    expect(voiceSupportsSpeed("bg-piper:dimitar")).toBe(true);
    expect(voiceSupportsSpeed("bg-bgtts:female")).toBe(false);
  });

  it("disables speed control for the Meta MMS Bulgarian voice", () => {
    expect(voiceSupportsSpeed("bg-mms:bul")).toBe(false);
  });

  it("disables speed control for Pocket TTS, which has no speed parameter", () => {
    expect(voiceSupportsSpeed("pocket:alba")).toBe(false);
  });

  it("keeps speed control enabled for Kokoro", () => {
    expect(voiceSupportsSpeed("af_heart")).toBe(true);
  });

  it("enables speed control for the macOS say voice", () => {
    expect(voiceSupportsSpeed("say:daria-enhanced")).toBe(true);
  });

  it("enables speed control for Cartesia voices", () => {
    expect(voiceSupportsSpeed("cartesia:a0e99841")).toBe(true);
  });
});

describe("previewLanguageFor", () => {
  it("previews an ElevenLabs voice in the language it is listed under, and nothing else in another", () => {
    expect(previewLanguageFor("elevenlabs:JBFqnCBsd6RMkjVDRZzb", "bg")).toBe("bg");
    expect(previewLanguageFor("elevenlabs:JBFqnCBsd6RMkjVDRZzb", "xx")).toBeNull();
    expect(previewLanguageFor("kokoro:af_heart", "bg")).toBeNull();
    expect(previewFileBase("elevenlabs:abc", "bg")).not.toBe(previewFileBase("elevenlabs:abc"));
  });

  it("says one Bulgarian sentence for a foreign ElevenLabs preview", async () => {
    const text = await getPreviewTextForVoice("elevenlabs:JBFqnCBsd6RMkjVDRZzb", "bg");
    expect(text).toMatch(/пролетна/);
    expect(text.match(/[.!?]/g)).toHaveLength(1);
  });
});
