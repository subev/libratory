import { describe, expect, it } from "vitest";

import type { OcrWord } from "./ocr-tesseract.ts";
import { alignWords, placeBlocks } from "./word-alignment.ts";

// Words laid left to right on numbered lines, 10 px a letter, 20 px tall, lines 30 px apart
function ocrLine(line: number, ...words: string[]): OcrWord[] {
  let x = 100;
  return words.map((text) => {
    const box: OcrWord["box"] = [x, line * 30, x + text.length * 10, line * 30 + 20];
    x += text.length * 10 + 10;
    return { text, box, conf: 90, line };
  });
}

describe("alignWords", () => {
  it("matches in order, so a repeated word takes its own occurrence", () => {
    const ocr = [...ocrLine(0, "на", "масата", "на"), ...ocrLine(1, "стола")];
    const aligned = alignWords(["на", "масата", "на", "стола"], ocr);
    expect(aligned.map((a) => a.ocr)).toEqual([0, 1, 2, 3]);
  });

  it("forgives a misread letter but not a different word", () => {
    const aligned = alignWords(["обособена", "част"], ocrLine(0, "обосабена", "чаcт"));
    expect(aligned.map((a) => a.ocr)).toEqual([0, 1]);
    expect(alignWords(["къща"], ocrLine(0, "море")).map((a) => a.ocr)).toEqual([null]);
  });

  it("gives a word the model joined both halves of the OCR's hyphenated split", () => {
    const ocr = [...ocrLine(0, "една", "обо-"), ...ocrLine(1, "собена", "част")];
    const aligned = alignWords(["една", "обособена", "част"], ocr);
    expect(aligned).toEqual([{ ocr: 0, merged: false, score: 1 }, { ocr: 1, merged: true, score: 1 }, { ocr: 3, merged: false, score: 1 }]);
  });

  it("carries how alike the partner was, so the words the readers disagree on can be named", () => {
    const placed = placeBlocks(["включените материали не съвпадат"], ocrLine(0, "включените", "материали", "пе", "съвпадат"));
    // The model wrote "не", the reader "пе": in a two-letter word that is no match at all, so guessed
    expect(placed.words[2]).toMatchObject({ matched: false });
    expect(placed.words[2]!.score).toBeUndefined();
    expect(placed.doubtful).toEqual([]);
    const longer = placeBlocks(["включените материали"], ocrLine(0, "включeните", "материали"));
    expect(longer.words[0]!.score).toBeCloseTo(0.9, 5);
    expect(longer.doubtful).toEqual([]);
    const off = placeBlocks(["репертоар"], ocrLine(0, "репертоап"));
    expect(off.words[0]!.score).toBeCloseTo(8 / 9, 5);
    expect(off.doubtful).toEqual([]);
    const doubtful = placeBlocks(["материали"], ocrLine(0, "матeриaли"));
    expect(doubtful.doubtful).toEqual(["материали"]);
  });

  it("never matches on punctuation alone: a dialogue dash is not the same word as a stray hyphen", () => {
    // Every line of Bulgarian dialogue opens with a lone dash; it must not take an unrelated
    // noise token's box and push the real words off their partners
    const aligned = alignWords(["—", "друга", "дума"], ocrLine(0, "шум", "-", "друга", "дума"));
    expect(aligned.map((a) => a.ocr)).toEqual([null, 2, 3]);
  });

  it("skips OCR words the model left out and model words the OCR never saw", () => {
    const ocr = [...ocrLine(0, "12", "ГЛАВА", "ПЪРВА"), ...ocrLine(1, "Беше", "тъмна", "нощ")];
    const aligned = alignWords(["ГЛАВА", "ПЪРВА", "Беше", "много", "тъмна", "нощ"], ocr);
    expect(aligned.map((a) => a.ocr)).toEqual([1, 2, 3, null, 4, 5]);
  });
});

describe("placeBlocks", () => {
  it("keeps missing words unlocated instead of guessing inside or beside another line", () => {
    const placed = placeBlocks(["Беше тъмна нощ", "Ново заглавие"], ocrLine(0, "Беше", "нощ"));
    expect(placed.words.filter((w) => !w.matched).map((w) => w.box)).toEqual([null, null, null]);
    expect(placed.blockBoxes).toEqual([[100, 0, 180, 20], null]);
  });

  it("aligns blocks independently when OCR reports columns in a different order", () => {
    const left = ocrLine(0, "Left", "poem");
    const right = ocrLine(1, "Right", "poem");
    const placed = placeBlocks(["Right poem", "Left poem"], [...left, ...right]);
    expect(placed.words.map((w) => w.indices)).toEqual([[2], [3], [0], [1]]);
    expect(placed.matchedShare).toBe(1);
  });

  it("places a spaced heading on measured heading words without rewriting the text", () => {
    const placed = placeBlocks(["П Е С Н И Н А Ф И Л Е К"], ocrLine(2, "ПЕСНИ", "НА", "ФИЛЕК"));
    expect(placed.words.map((w) => w.text)).toEqual(["П Е С Н И", "Н А", "Ф И Л Е К"]);
    expect(placed.words.map((w) => w.indices)).toEqual([[0], [1], [2]]);
    expect(placed.words.every((w) => w.box?.[1] === 60)).toBe(true);
  });

  it("keeps both measured halves when a joined word crosses a line", () => {
    const placed = placeBlocks(["обособена част"], [...ocrLine(0, "обо-"), ...ocrLine(1, "собена", "част")]);
    expect(placed.words[0]?.indices).toEqual([0, 1]);
  });

  it("does not reuse one printed occurrence for two separate blocks", () => {
    const placed = placeBlocks(["same words", "same words"], ocrLine(0, "same", "words"));
    expect(placed.words.filter((w) => w.block === 1).every((w) => w.box === null)).toBe(true);
  });

  it("keeps empty and invalid geometry unlocated", () => {
    expect(placeBlocks(["Беше нощ"], []).blockBoxes).toEqual([null]);
    expect(placeBlocks([], []).matchedShare).toBeNull();
    expect(placeBlocks(["bad"], [{ text: "bad", conf: 90, line: 0, box: [0, 0, NaN, 10] }]).words[0]?.box).toBeNull();
  });
});
