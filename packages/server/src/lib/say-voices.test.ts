import { describe, expect, it } from "vitest";

import { parseSayVoiceList, sayVoiceSlug } from "./say-voices.ts";

const SAMPLE_OUTPUT = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Daria               bg_BG    # Hello! My name is Daria.",
  "Daria (Enhanced)    bg_BG    # Hello! My name is Daria.",
  "Eddy (English (United States)) en_US    # Hello! My name is Eddy.",
  "Fiona               en-scotland # Hello! My name is Fiona.",
  "",
].join("\n");

describe("parseSayVoiceList", () => {
  it("parses names, locales, and samples from say -v output", () => {
    const voices = parseSayVoiceList(SAMPLE_OUTPUT);
    expect(voices).toHaveLength(5);
    expect(voices[1]).toEqual({
      slug: "daria",
      name: "Daria",
      locale: "bg_BG",
      sample: "Hello! My name is Daria.",
    });
    expect(voices[2]?.slug).toBe("daria-enhanced");
    expect(voices[2]?.name).toBe("Daria (Enhanced)");
  });

  it("keeps names with nested parentheses intact", () => {
    const voices = parseSayVoiceList(SAMPLE_OUTPUT);
    expect(voices[3]?.name).toBe("Eddy (English (United States))");
    expect(voices[3]?.slug).toBe("eddy-english-united-states");
  });

  it("handles dashed locales", () => {
    const voices = parseSayVoiceList(SAMPLE_OUTPUT);
    expect(voices[4]).toMatchObject({ slug: "fiona", locale: "en-scotland" });
  });
});

describe("sayVoiceSlug", () => {
  it("slugs to lowercase alphanumerics and dashes", () => {
    expect(sayVoiceSlug("Daria (Enhanced)")).toBe("daria-enhanced");
    expect(sayVoiceSlug("Bad News")).toBe("bad-news");
  });
});
