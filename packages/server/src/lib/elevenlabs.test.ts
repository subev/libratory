import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../env.ts", () => ({
  env: { ELEVENLABS_API_KEY: "sk_eleven_test", ELEVENLABS_MODEL: "eleven_multilingual_v2", DATA_DIR: "/tmp/libratory-test" },
}));

import { charactersToWords, elevenLabsQuota, listElevenLabsVoices, recordElevenLabsSpend } from "./elevenlabs.ts";

// The API hands back one entry per character; these helpers spell a sentence out the same way.
function alignment(text: string, msPerChar = 50) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => (i * msPerChar) / 1000),
    character_end_times_seconds: characters.map((_, i) => ((i + 1) * msPerChar) / 1000),
  };
}

const rebuild = (words: { text: string; after: string }[]) => words.map((w) => w.text + w.after).join("");

describe("charactersToWords", () => {
  it("groups characters into words and keeps the spacing between them", () => {
    const text = "Such a study.";
    const words = charactersToWords(alignment(text), text);

    expect(words.map((w) => w.text)).toEqual(["Such", "a", "study."]);
    expect(rebuild(words)).toBe(text);
    expect(words[0]).toEqual({ text: "Such", after: " ", startMs: 0, endMs: 200 });
    expect(words[2]?.endMs).toBe(650);
  });

  it("carries a newline through as the spacing it is, rather than flattening it to a space", () => {
    const text = "one\ntwo";
    const words = charactersToWords(alignment(text), text);

    expect(words.map((w) => w.after)).toEqual(["\n", ""]);
    expect(rebuild(words)).toBe(text);
  });

  it("keeps a run of whitespace whole", () => {
    const text = "a  b";
    expect(rebuild(charactersToWords(alignment(text), text))).toBe(text);
  });

  // Normalization ("Dr." spoken as "Doctor") shifts every character after it, so the words would
  // land on the wrong print. No timings at all is the honest answer.
  it("returns nothing when the returned characters are not the text we sent", () => {
    const text = "Dr. Frankenstein";
    expect(charactersToWords(alignment("Doctor Frankenstein"), text)).toEqual([]);
  });

  it("returns nothing when the timing arrays are ragged or missing", () => {
    expect(charactersToWords({ characters: ["a"], character_start_times_seconds: [0], character_end_times_seconds: [] }, "a")).toEqual([]);
    expect(charactersToWords(null, "a")).toEqual([]);
  });
});

describe("elevenLabsQuota", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ character_count: 44, character_limit: 10_000, tier: "free" }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Their balance takes ~10s to move, so a second chapter would otherwise preflight against a
  // number that still thinks the first one never happened.
  it("subtracts what this process has billed since the balance was last read", async () => {
    expect((await elevenLabsQuota())!.remaining).toBe(9_956);

    recordElevenLabsSpend(1_000);
    expect((await elevenLabsQuota())!.remaining).toBe(8_956);
  });
});

describe("listElevenLabsVoices", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows next_page_token and folds the labels into one tagline", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          voices: [{
            voice_id: "v1",
            name: "Charlotte",
            labels: { accent: "swedish", gender: "female", use_case: "narration" },
            verified_languages: [{ language: "EN" }],
          }],
          has_more: true,
          next_page_token: "page2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          voices: [{ voice_id: "v2", name: "Boris", fine_tuning: { language: "bg" } }],
          has_more: false,
        }),
      });

    const voices = await listElevenLabsVoices();

    expect(voices).toEqual([
      { id: "v1", name: "Charlotte", language: "en", gender: "female", tagline: "swedish · narration" },
      { id: "v2", name: "Boris", language: "bg", gender: null, tagline: "" },
    ]);
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("next_page_token=page2");
  });
});
