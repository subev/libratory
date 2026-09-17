import type { LlmPage, Reference } from "./ocr-llm.ts";
import type { PdfPageSize, OcrWord } from "./ocr-tesseract.ts";
import { placeOcrPage, type NativeOcr } from "./ocr-geometry.ts";
import type { GeometryPage } from "./page-geometry.ts";
import type { TextLayerPage } from "./pdf-text-layer.ts";
import type { Box } from "./word-alignment.ts";

export function placeOrderedPage(page: LlmPage, reference: Reference | null, size: PdfPageSize, index: number) {
  const groups = page.lineGroups ?? [];
  if (groups.length !== page.blocks.length) throw new Error("Saved line groups do not match transcription blocks");
  const refs: OcrWord[][] = groups.map(() => []);
  for (const word of reference?.words ?? []) {
    if (!reference?.width || !reference.height) continue;
    const box: Box = [word.box[0] / reference.width * 1000, word.box[1] / reference.height * 1000, word.box[2] / reference.width * 1000, word.box[3] / reference.height * 1000];
    let best = 0, owner = -1, lineId = -1;
    groups.forEach((lines, i) => lines.forEach((line) => {
      const b = line.box;
      const overlap = Math.max(0, Math.min(b[2], box[2]) - Math.max(b[0], box[0])) * Math.max(0, Math.min(b[3], box[3]) - Math.max(b[1], box[1]));
      if (overlap > best) { best = overlap; owner = i; lineId = line.id; }
    }));
    if (best >= (box[2] - box[0]) * (box[3] - box[1]) / 2) refs[owner]?.push({ ...word, line: lineId });
  }
  const native: NativeOcr = { words: [], blocks: [] };
  const geometry: GeometryPage = { i: index, w: size.width, h: size.height, rot: size.rotation ?? 0, cropOffset: [0, 0], lines: [], native };
  const words: TextLayerPage["words"] = [];
  const doubtful: string[] = [];
  let matched = 0, total = 0;
  const blocks = page.blocks.map((block, i) => {
    const lineOrder = new Map((groups[i] ?? []).map((line, index) => [line.id, index]));
    const reading = [...(refs[i] ?? [])].sort((a, b) => (lineOrder.get(a.line) ?? 0) - (lineOrder.get(b.line) ?? 0));
    const ref = reference ? { ...reference, words: reading, text: reading.map((w) => w.text).join(" ") } : null;
    const placed = placeOcrPage([block.text], ref, size, index);
    const offset = native.words.length;
    native.words.push(...(placed.geometry.native?.words ?? []));
    native.blocks.push(...(placed.geometry.native?.blocks ?? []).map((b) => ({ ...b, words: b.words.map((w) => ({ ...w, indices: w.indices.map((n) => n + offset) })) })));
    geometry.lines.push(...placed.geometry.lines);
    words.push(...placed.layer);
    doubtful.push(...placed.placement.doubtful);
    total += placed.placement.words.length;
    matched += placed.placement.words.filter((w) => w.matched).length;
    const box = placed.boxes[0];
    return { ...block, polygon: box ?? undefined };
  });
  return { page: { ...page, blocks }, geometry, words, placed: reference && total ? matched / total : null, doubtful };
}
