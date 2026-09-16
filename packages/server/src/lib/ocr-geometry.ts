import type { OcrPage, PdfPageSize } from "./ocr-tesseract.ts";
import type { GeometryPage, GeometryLine } from "./page-geometry.ts";
import type { TextLayerPage } from "./pdf-text-layer.ts";
import { placeBlocks, type Box } from "./word-alignment.ts";

export type NativeOcr = {
  words: { text: string; box: Box; line: number }[];
  blocks: { text: string; words: { start: number; end: number; indices: number[] }[] }[];
};

export function placeOcrPage(texts: string[], reference: OcrPage | null, size: PdfPageSize, index: number) {
  const bounds = reference?.width && reference.height ? { width: reference.width, height: reference.height } : null;
  const reading = bounds ? (reference?.words ?? []).filter(({ box }) => box.every(Number.isFinite)
    && box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1]
    && box[2] <= bounds.width && box[3] <= bounds.height) : [];
  const placement = placeBlocks(texts, reading, bounds);
  const sx = bounds ? size.width / bounds.width : 1;
  const sy = bounds ? size.height / bounds.height : 1;
  const scale = (b: Box): Box => [b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy];
  const words = reading.map(({ text, box, line }) => ({ text, box: scale(box), line }));
  const lines = new Map<number, GeometryLine>();
  for (const word of words) {
    const line = lines.get(word.line);
    if (line) {
      line.t += ` ${word.text}`;
      line.b = unionBox(line.b, word.box);
    } else lines.set(word.line, { t: word.text, b: word.box });
  }
  const native: NativeOcr = { words, blocks: texts.map((text, block) => ({ text,
    words: placement.words.filter((word) => word.block === block && word.matched)
      .map(({ start, end, indices }) => ({ start, end, indices })),
  })) };
  const geometry: GeometryPage = { i: index, w: size.width, h: size.height, rot: size.rotation ?? 0, cropOffset: [0, 0], lines: [...lines.values()], native };
  const layer: TextLayerPage["words"] = placement.words.flatMap((word) => {
    const measured = word.indices.flatMap((i) => words[i] ? [words[i]] : []);
    if (measured.length === 0) return [];
    const pieces = splitText(word.text, measured.map((w) => w.text));
    return measured.flatMap((part, i) => pieces[i] ? [{ text: pieces[i], bbox: part.box }] : []);
  });
  return { geometry, layer, placement, boxes: placement.blockBoxes.map((b) => b ? scale(b) : null) };
}

export function unionBox(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function splitText(text: string, parts: string[]): string[] {
  if (parts.length === 1) return [text];
  const letters = [...text.matchAll(/[\p{L}\p{N}]/gu)];
  const lengths = parts.map((p) => [...p.matchAll(/[\p{L}\p{N}]/gu)].length);
  const total = lengths.reduce((a, b) => a + b, 0);
  let used = 0;
  let from = 0;
  return parts.map((_, i) => {
    used += lengths[i] ?? 0;
    const to = i === parts.length - 1 || total === 0 ? text.length
      : letters[Math.round(letters.length * used / total)]?.index ?? text.length;
    const piece = text.slice(from, to);
    from = to;
    return piece;
  });
}

// Joining a page-end hyphen can remove the first word (or whole block) on the next page.
// Keep source-text offsets in the same form as the chapter layout, without moving any boxes.
export function reconcileNativeBlocks(geometry: GeometryPage[], texts: string[][]): void {
  geometry.forEach((page, i) => {
    if (!page.native) return;
    const joined = texts[i] ?? [];
    const old = page.native.blocks;
    const skipped = Math.max(0, old.length - joined.length);
    page.native.blocks = joined.map((text, j) => {
      const block = old[j + skipped];
      if (!block) return { text, words: [] };
      // Only the first word can be removed and the last word extended by page joining.
      const oldPrefix = block.text.slice(0, block.text.lastIndexOf(" ") + 1);
      const newPrefix = text.slice(0, text.lastIndexOf(" ") + 1);
      const removed = block.text.endsWith(text) ? block.text.length - text.length
        : oldPrefix.endsWith(newPrefix) ? oldPrefix.length - newPrefix.length : 0;
      const words = block.words.flatMap((w) => w.end <= removed ? [] : [{ ...w,
        start: Math.max(0, w.start - removed),
        end: w.end === block.text.length ? text.length : Math.min(text.length, w.end - removed),
      }]);
      return { text, words };
    });
  });
}
