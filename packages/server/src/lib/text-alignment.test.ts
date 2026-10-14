import { describe, expect, it } from "vitest";

import { alignTexts, KEPT, tokenize } from "./text-alignment.ts";

const ORIGINAL = [
  "THE RAVEN 17",
  "",
  "Once upon a midnight dreary, while I pon-",
  "dered, weak and weary, over many a quaint",
  "and curious volume of forgotten lore.",
  "",
  "1 A footnote that the print carries at the foot of the page, long enough to matter.",
].join("\n");

const slice = (text: string, span: [number, number] | null) => (span ? text.slice(span[0], span[1]) : null);
const spanOf = (text: string, needle: string): [number, number] => {
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`${needle} not in text`);
  return [at, at + needle.length];
};

describe("tokenize", () => {
  it("keeps words by their letters and digits and leaves punctuation out", () => {
    expect(tokenize("«Hello,» — said THE-Raven 17.").map((t) => t.key)).toEqual(["hello", "said", "theraven", "17"]);
  });
});

describe("alignTexts", () => {
  it("is the identity on an unchanged text", () => {
    const alignment = alignTexts(ORIGINAL, ORIGINAL)!;
    expect(alignment.fit).toBe(1);
    const span = spanOf(ORIGINAL, "weak and weary");
    expect(alignment.toOriginal(...span)).toEqual(span);
    expect(alignment.toEdited(...span)).toEqual(span);
  });

  it("lands a corrected word on the word it corrects", () => {
    const edited = ORIGINAL.replace("pon-\ndered", "pondered").replace("quaint", "quaint");
    const alignment = alignTexts(edited, ORIGINAL)!;
    expect(slice(ORIGINAL, alignment.toOriginal(...spanOf(edited, "pondered")))).toBe("pon-\ndered");
    expect(alignment.fit).toBeGreaterThan(0.9);
  });

  it("carries a sentence across a one-word fix with its neighbours intact", () => {
    const edited = ORIGINAL.replace("curious", "furious");
    const alignment = alignTexts(edited, ORIGINAL)!;
    expect(slice(ORIGINAL, alignment.toOriginal(...spanOf(edited, "and furious volume")))).toBe("and curious volume");
    expect(slice(ORIGINAL, alignment.toOriginal(...spanOf(edited, "furious")))).toBe("curious");
  });

  it("drops a page header and a footnote without losing its place after them", () => {
    const edited = ORIGINAL.replace("THE RAVEN 17\n\n", "").replace(/\n\n1 A footnote.*$/, "");
    const alignment = alignTexts(edited, ORIGINAL)!;
    expect(alignment.fit).toBe(1);
    expect(slice(ORIGINAL, alignment.toOriginal(...spanOf(edited, "forgotten lore")))).toBe("forgotten lore");
    expect(alignment.toEdited(...spanOf(ORIGINAL, "A footnote that the print carries"))).toBeNull();
    expect(alignment.toEdited(...spanOf(ORIGINAL, "THE RAVEN 17"))).toBeNull();
  });

  it("gives words typed in nowhere to go, and keeps the sentence around them", () => {
    const edited = ORIGINAL.replace("forgotten lore.", "forgotten lore, as the poet wrote.");
    const alignment = alignTexts(edited, ORIGINAL)!;
    expect(alignment.toOriginal(...spanOf(edited, "as the poet wrote"))).toBeNull();
    expect(slice(ORIGINAL, alignment.toOriginal(...spanOf(edited, "volume of forgotten lore, as the poet wrote."))))
      .toBe("volume of forgotten lore");
  });

  it("maps punctuation alone to nothing", () => {
    const alignment = alignTexts(ORIGINAL, ORIGINAL)!;
    const comma = ORIGINAL.indexOf(",");
    expect(alignment.toOriginal(comma, comma + 1)).toBeNull();
  });

  it("gives up on a rewrite, which no geometry can follow", () => {
    expect(alignTexts("Rewritten by hand, so the print says something else now.", ORIGINAL)).toBeNull();
    expect(alignTexts("", ORIGINAL)).toBeNull();
  });

  it("holds fit under KEPT when it does line a loose edit up", () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    const edited = words.map((w, i) => (i % 2 ? w : `other${i}`)).join(" ");
    const alignment = alignTexts(edited, words.join(" "));
    // Half the words replaced: an alignment exists only if the cap admits it, and either answer
    // is below the bar
    expect(alignment === null || alignment.fit < KEPT).toBe(true);
  });

  it("lines a long chapter up in linear time, however scattered the corrections", () => {
    // Prose has few repeated three-word runs, so the texts are pinned every few words and no
    // stretch between pins is long enough for the diff to cost anything
    const vocabulary = Array.from({ length: 400 }, (_, i) => `w${i.toString(36)}`);
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const original = Array.from({ length: 40_000 }, () => vocabulary[Math.floor(random() * vocabulary.length)]!);
    const edited = original.map((word) => (random() < 0.3 ? `${word}x` : word));
    const started = Date.now();
    const alignment = alignTexts(edited.join(" "), original.join(" "), { timeoutMs: 60_000 })!;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(alignment.fit).toBeGreaterThan(0.65);
    expect(alignment.fit).toBeLessThan(0.75);
    const at = edited.slice(0, 1000).join(" ").length + 1;
    const word = edited[1000]!;
    const mapped = alignment.toOriginal(at, at + word.length);
    expect(mapped && original.join(" ").slice(mapped[0], mapped[1])).toBe(original[1000]);
  });

  it("follows an AI cleanup pass: OCR substitutions, joined hyphens, furniture gone", () => {
    const scanned = "F0 REWO R D\n\nThe qu1ck brown fox jum-\nped over the lazy d0g. 23\n\nIt was the best of tirnes, it was the worst of times.";
    const cleaned = "FOREWORD\n\nThe quick brown fox jumped over the lazy dog.\n\nIt was the best of times, it was the worst of times.";
    const alignment = alignTexts(cleaned, scanned)!;
    expect(alignment.fit).toBeGreaterThanOrEqual(KEPT);
    expect(slice(scanned, alignment.toOriginal(...spanOf(cleaned, "quick brown fox jumped over the lazy dog"))))
      .toBe("qu1ck brown fox jum-\nped over the lazy d0g");
    expect(slice(scanned, alignment.toOriginal(...spanOf(cleaned, "best of times")))).toBe("best of tirnes");
  });
});
