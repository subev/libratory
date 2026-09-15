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
  it("boxes every word, guesses the missing ones from their neighbours, and boxes each block", () => {
    const ocr = [...ocrLine(0, "Глава", "първа"), ...ocrLine(1, "Беше", "нощ"), ...ocrLine(2, "и", "валеше")];
    const placed = placeBlocks(["Глава първа", "Беше тъмна нощ и валеше сняг"], ocr);
    const byText = Object.fromEntries(placed.words.map((w) => [w.text, w]));
    expect(byText["Глава"]).toMatchObject({ block: 0, matched: true, box: [100, 0, 150, 20] });
    // Between "Беше" (ends at 140) and "нощ" (starts at 150) on the same line
    expect(byText["тъмна"]).toMatchObject({ matched: false });
    expect(byText["тъмна"]!.box![0]).toBeGreaterThanOrEqual(140);
    expect(byText["тъмна"]!.box![2]).toBeLessThanOrEqual(150);
    expect(byText["тъмна"]!.box![1]).toBe(30);
    // After the last placed word on its line, one letter's width per character
    expect(byText["сняг"]).toMatchObject({ matched: false, box: [190, 60, 230, 80] });
    expect(placed.blockBoxes).toEqual([[100, 0, 210, 20], [100, 30, 230, 80]]);
    expect(placed.matchedShare).toBeCloseTo(6 / 8);
  });

  it("places nothing when the OCR saw nothing, and reports no share for an empty page", () => {
    const placed = placeBlocks(["Беше нощ"], []);
    expect(placed.words.every((w) => w.box === null && !w.matched)).toBe(true);
    expect(placed.blockBoxes).toEqual([null]);
    expect(placed.matchedShare).toBe(0);
    expect(placeBlocks([], ocrLine(0, "12")).matchedShare).toBeNull();
  });

  it("squeezes a run that would hang past the page edge into the space left", () => {
    const bounds = { width: 300, height: 100 };
    const right = placeBlocks(["нощ и валеше сняг и вятър и дъжд"], ocrLine(0, "нощ"), bounds);
    for (const w of right.words) expect(w.box![2]).toBeLessThanOrEqual(300);
    expect(right.words.at(-1)!.box![2]).toBeCloseTo(300, 5);
    const left = placeBlocks(["беше тъмна и студена нощ"], ocrLine(0, "нощ"), bounds);
    for (const w of left.words) expect(w.box![0]).toBeGreaterThanOrEqual(0);
    expect(left.words[0]!.box![0]).toBe(0);
    // Room to spare: the natural width is kept
    expect(placeBlocks(["нощ и"], ocrLine(0, "нощ"), bounds).words[1]!.box).toEqual([140, 0, 150, 20]);
  });

  it("puts a run the OCR skipped at the start of the next placed word's line when there is room there", () => {
    // Tesseract read the poem's last line and only the right half of the next line
    const ocr = [...ocrLine(0, "за", "башат", "песнопойката!"), { text: "споменат:", box: [500, 30, 590, 50] as OcrWord["box"], conf: 90, line: 1 }];
    const placed = placeBlocks(["за башат песнопойката!", "От тази категория заслужава да се споменат: Пагона"], ocr, { width: 800, height: 100 });
    const byText = Object.fromEntries(placed.words.map((w) => [w.text, w]));
    expect(byText["От"]!.box![1]).toBe(30);
    expect(byText["От"]!.box![0]).toBeGreaterThanOrEqual(100);
    expect(byText["се"]!.box![2]).toBeLessThan(500);
    // No room on the next line: after the previous word instead
    const tight = placeBlocks(["за башат песнопойката!", "От тази споменат:"], [...ocrLine(0, "за", "башат", "песнопойката!"), { text: "споменат:", box: [100, 30, 190, 50] as OcrWord["box"], conf: 90, line: 1 }], { width: 800, height: 100 });
    expect(Object.fromEntries(tight.words.map((w) => [w.text, w]))["От"]!.box![1]).toBe(0);
  });

  it("hangs words before the first placed one off its left edge", () => {
    const placed = placeBlocks(["тъмна нощ"], ocrLine(0, "нощ"));
    const dark = placed.words[0]!;
    expect(dark.matched).toBe(false);
    expect(dark.box![2]).toBeLessThanOrEqual(100);
    expect(dark.box![1]).toBe(0);
  });
});
