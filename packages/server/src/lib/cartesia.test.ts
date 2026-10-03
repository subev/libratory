import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DATA_DIR too: writing per-chunk word timings pulls the output-path helpers into the graph
vi.mock("../env.ts", () => ({
  env: { CARTESIA_API_KEY: "sk_car_test", DATA_DIR: "/tmp/libratory-test" },
}));

import { cartesiaErrorMessage, listCartesiaVoices } from "./cartesia.ts";
import { pcm16WavHeader } from "./wav.ts";

const mockFetch = vi.fn();

describe("pcm16WavHeader", () => {
  it("writes a valid 44-byte mono PCM16 header", () => {
    const header = pcm16WavHeader(1000, 44100);
    expect(header.length).toBe(44);
    expect(header.toString("ascii", 0, 4)).toBe("RIFF");
    expect(header.readUInt32LE(4)).toBe(1036);
    expect(header.toString("ascii", 8, 12)).toBe("WAVE");
    expect(header.readUInt32LE(24)).toBe(44100);
    expect(header.readUInt16LE(22)).toBe(1);
    expect(header.readUInt32LE(40)).toBe(1000);
  });
});

describe("cartesiaErrorMessage", () => {
  it("states the credits a refused chunk needed and the account had, without the raw JSON", () => {
    const body = JSON.stringify({
      error_code: "quota_exceeded",
      message: "This request requires approximately 349 credits but you have 125 remaining. Please upgrade your subscription or enable overages at https://play.cartesia.ai/subscription.",
      title: "Insufficient credits",
    });
    const message = cartesiaErrorMessage(402, body);
    expect(message).toMatch(/^Cartesia is out of credits: the next chunk needs about 349 credits and 125 are left/);
    expect(message).not.toContain("error_code");
  });

  it("keeps the status and message of any other failure", () => {
    expect(cartesiaErrorMessage(500, JSON.stringify({ message: "boom" }))).toBe("Cartesia TTS error 500: boom");
    expect(cartesiaErrorMessage(502, "Bad gateway")).toBe("Cartesia TTS error 502: Bad gateway");
  });
});

describe("listCartesiaVoices", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paginates until has_more is false and maps voice fields", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "v1", name: "Ana", language: "bg", gender: "feminine", tagline: "Warm narrator" }],
          has_more: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "v2", name: "Boris", language: "bg", gender: "masculine", tagline: null }],
          has_more: false,
        }),
      });

    const voices = await listCartesiaVoices();

    expect(voices).toEqual([
      { id: "v1", name: "Ana", language: "bg", gender: "feminine", tagline: "Warm narrator" },
      { id: "v2", name: "Boris", language: "bg", gender: "masculine", tagline: "" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondUrl = String(mockFetch.mock.calls[1]?.[0]);
    expect(secondUrl).toContain("starting_after=v1");
  });
});
