import { describe, expect, it } from "vitest";
import { STANDARD_EXTRACTION } from "./extraction-presets.ts";
import { fileExtractionSettings, proseSettings, routePage } from "./ocr-routing.ts";
import type { OcrLine } from "./ocr-line-order.ts";

const settings = { ...STANDARD_EXTRACTION, lineOrdering: true, pageRouting: "auto" as const };
const prose: OcrLine[] = Array.from({ length: 12 }, (_, i) => ({ id: i + 1,
  text: i % 4 === 3 ? "The end of a paragraph." : "The printed line continues into the next printed line",
  box: [100, 100 + i * 30, i % 4 === 3 ? 450 : 900, 120 + i * 30],
}));

describe("local page routing", () => {
  it("uses one transcription for clear prose without a classifier call", () => {
    expect(routePage(settings, prose).route).toBe("standard");
  });
  it("keeps columns, numbered verse and uncertain layouts on the ordered path", () => {
    expect(routePage(settings, prose.map((line) => ({ ...line, box: [100, line.box[1], 400, line.box[3]] }))).route).toBe("ordered");
    expect(routePage(settings, prose.map((line, i) => ({ ...line, text: i === 5 ? "5 The verse beside its counter" : line.text }))).route).toBe("ordered");
    expect(routePage(settings, []).route).toBe("ordered");
  });
  it("honours an explicit prose section independently of the book preset", () => {
    const book = { ...settings, prompt: "Song instructions", fileRouting: { prose: "prose" as const } };
    const selected = fileExtractionSettings(book, "prose");
    expect(routePage(selected, []).route).toBe("standard");
    expect(proseSettings(selected).prompt).toBe(STANDARD_EXTRACTION.prompt);
    expect(fileExtractionSettings(book, "other").pageRouting).toBe("auto");
  });
  it("keeps custom transcription wording when automatically bypassing ordering", () => {
    expect(proseSettings({ ...settings, prompt: "Keep historical spelling" }).prompt).toBe("Keep historical spelling");
    expect(routePage({ ...settings, pageRouting: "preset" }, prose).route).toBe("ordered");
  });
});
