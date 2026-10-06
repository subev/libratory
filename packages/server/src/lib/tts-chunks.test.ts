import { describe, expect, it } from "vitest";

import { chunkTextForTts, PARAGRAPH_CHUNKS, SENTENCE_CHUNKS } from "./tts-chunks.ts";

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

// ~52-char Bulgarian sentence, used to build inputs of predictable size.
const SENTENCE = "Малката къща стоеше тихо в края на старото село.";

describe("chunkTextForTts", () => {
  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkTextForTts("", SENTENCE_CHUNKS)).toEqual([]);
    expect(chunkTextForTts("   \n\n  ", PARAGRAPH_CHUNKS)).toEqual([]);
  });

  it("keeps one sentence per chunk in sentence mode", () => {
    const text = Array.from({ length: 4 }, () => SENTENCE).join(" ");

    const sentences = chunkTextForTts(text, SENTENCE_CHUNKS);

    expect(sentences).toHaveLength(4);
    expect(normalize(sentences.join(" "))).toBe(normalize(text));
  });

  it("keeps a paragraph whole in paragraph mode, and splits one past the cap at sentences", () => {
    const short = Array(4).fill(SENTENCE).join(" ");
    expect(chunkTextForTts(short, PARAGRAPH_CHUNKS)).toEqual([short]);

    const long = Array(30).fill(SENTENCE).join(" "); // ~1,560 chars
    const chunks = chunkTextForTts(long, PARAGRAPH_CHUNKS);
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= PARAGRAPH_CHUNKS.maxChars && chunk.endsWith("."))).toBe(true);
    expect(normalize(chunks.join(" "))).toBe(normalize(long));
  });

  it("falls back to splitting a sentence longer than the cap by words", () => {
    const text = "Това е много дълго изречение без естествена пауза ".repeat(18).trim();

    const chunks = chunkTextForTts(text, SENTENCE_CHUNKS);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= SENTENCE_CHUNKS.maxChars)).toBe(true);
    expect(normalize(chunks.join(" "))).toBe(normalize(text));
  });

  // Two passages BgTTS read with no pause after the title, 2026-10-06
  it("never merges a chunk across a blank line, so a title gets its own pause", () => {
    for (const limits of [SENTENCE_CHUNKS, PARAGRAPH_CHUNKS]) {
      expect(
        chunkTextForTts("39 Дяволът и неговата баба\n\nИмало едно време една голяма война и кралят плащал оскъдно.", limits),
      ).toEqual(["39 Дяволът и неговата баба", "Имало едно време една голяма война и кралят плащал оскъдно."]);
    }
    expect(
      chunkTextForTts("СВЕКЪРВА И СНАХА\r\n\r\n1055. ГЛЕДАМ ТЕ, ГЛЕДАМ, СТОЯНЕ\n \nМари, Калинко-Малинко,\nщо ме, Калинко, не гледаш?", SENTENCE_CHUNKS),
    ).toEqual(["СВЕКЪРВА И СНАХА", "1055. ГЛЕДАМ ТЕ, ГЛЕДАМ, СТОЯНЕ", "Мари, Калинко-Малинко, що ме, Калинко, не гледаш?"]);
  });
});
