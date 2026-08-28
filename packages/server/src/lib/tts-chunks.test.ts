import { describe, expect, it } from "vitest";

import { chunkTextForTts, SENTENCE_CHUNKS } from "./tts-chunks.ts";

const MAX = 320;

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

// ~52-char Bulgarian sentence, used to build inputs of predictable size.
const SENTENCE = "Малката къща стоеше тихо в края на старото село.";

describe("chunkTextForTts", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkTextForTts("")).toEqual([]);
    expect(chunkTextForTts("   \n\n  ")).toEqual([]);
  });

  it("keeps a short paragraph as a single chunk", () => {
    const text = "Това е кратък български абзац, който трябва да остане цял и да не бъде разделян.";

    expect(chunkTextForTts(text)).toEqual([text]);
  });

  it("merges short paragraphs across blank lines into one chunk when they fit", () => {
    // Each line alone would be a tiny, mumble-prone chunk; together they still fit under the cap.
    const text = ["Глава първа.", "", "Беше тиха пролетна сутрин.", "", "Светът мълчеше."].join("\n");

    const chunks = chunkTextForTts(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.length).toBeLessThanOrEqual(MAX);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));
  });

  it("packs long prose into balanced narrator-sized chunks", () => {
    const text = Array(12).fill(SENTENCE).join(" "); // ~635 chars

    const chunks = chunkTextForTts(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX)).toBe(true);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));

    // Balanced: no chunk is dramatically shorter than the largest (no tiny leftover tail).
    const lengths = chunks.map((chunk) => chunk.length);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(0.6 * Math.max(...lengths));
  });

  it("does not leave a tiny tail chunk when content can be spread evenly", () => {
    // Greedy-to-max would pack ~6 sentences then leave a small tail; balancing must avoid that.
    const text = Array(8).fill(SENTENCE).join(" "); // ~423 chars → 2 chunks

    const chunks = chunkTextForTts(text);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= MAX)).toBe(true);
    // Both halves are substantial — neither is an undersized, mumble-prone fragment.
    expect(chunks.every((chunk) => chunk.length >= 150)).toBe(true);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));
  });

  it("falls back to splitting a long sentence by words", () => {
    const text = "Това е много дълго изречение без естествена пауза ".repeat(18).trim();

    const chunks = chunkTextForTts(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX)).toBe(true);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));
  });
});

describe("chunkTextForTts with sentence limits", () => {
  it("keeps one sentence per chunk where the narrator would have packed several", () => {
    const text = Array.from({ length: 4 }, () => SENTENCE).join(" ");

    const narrator = chunkTextForTts(text);
    const sentences = chunkTextForTts(text, SENTENCE_CHUNKS);

    expect(narrator).toHaveLength(1);
    expect(sentences).toHaveLength(4);
    expect(sentences.every((chunk) => chunk.length <= SENTENCE_CHUNKS.maxChars)).toBe(true);
    expect(normalize(sentences.join(" "))).toBe(normalize(text));
  });
});
