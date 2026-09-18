import { STANDARD_EXTRACTION, type ExtractionSettings } from "./extraction-presets.ts";
import type { OcrLine } from "./ocr-line-order.ts";

export type PageRoute = "standard" | "ordered";

export function fileExtractionSettings(settings: ExtractionSettings, fileId: string): ExtractionSettings {
  return { ...settings, pageRouting: settings.fileRouting?.[fileId] ?? settings.pageRouting };
}

export function routePage(settings: ExtractionSettings, lines: OcrLine[]): { route: PageRoute; reason: string } {
  if (settings.pageRouting === "prose") return { route: "standard", reason: "Prose section selected" };
  if (!settings.lineOrdering) return { route: "standard", reason: "Standard extraction selected" };
  if (settings.pageRouting !== "auto") return { route: "ordered", reason: "Book ordering preset selected" };
  const body = lines.filter((line) => line.text.trim() && line.box[1] > 70 && line.box[3] < 900);
  if (body.length < 8) return { route: "ordered", reason: "Too little local evidence for simple prose" };
  const widths = body.map((line) => line.box[2] - line.box[0]);
  const wide = widths.filter((width) => width > 500).length;
  const sentences = body.filter((line) => /[.!?…][”’"')\]]?\s*$/u.test(line.text)).length;
  const counters = body.some((line) => /^\s*\d{1,3}\s+\p{L}/u.test(line.text));
  const columns = body.some((a) => body.some((b) => a.box[2] + 80 < b.box[0]
    && Math.min(a.box[3], b.box[3]) > Math.max(a.box[1], b.box[1])));
  if (!columns && !counters && wide / body.length >= 0.75 && sentences / body.length < 0.5) {
    return { route: "standard", reason: "Local lines indicate flowing single-column prose" };
  }
  return { route: "ordered", reason: "Columns, short lines or uncertain layout; keep the ordering preset" };
}

export function proseSettings(settings: ExtractionSettings): ExtractionSettings {
  return { ...STANDARD_EXTRACTION, prompt: settings.pageRouting === "prose" ? STANDARD_EXTRACTION.prompt : settings.prompt };
}
