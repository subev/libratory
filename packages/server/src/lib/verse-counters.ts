import type { LlmPage } from "./ocr-llm.ts";
import type { GeometryPage } from "./page-geometry.ts";
import type { Box } from "./word-alignment.ts";

export type RemovedVerseCounter = { block: number; lineId: number; text: string; start: number; end: number; box: Box };

export function cleanVerseCounters(page: LlmPage, geometry: GeometryPage): { page: LlmPage; removed: RemovedVerseCounter[] } {
  if (!page.lineGroups) throw new Error("Verse-counter cleanup requires ordered line evidence");
  if (!geometry.native && page.blocks.length) throw new Error("Verse-counter cleanup requires measured word positions");
  const native = geometry.native;
  const removed: RemovedVerseCounter[] = [];
  const lines = page.lineGroups.flat();
  const counters = new Map<number, { text: string; margin: number }>();
  for (const [group, entries] of page.lineGroups.entries()) {
    const block = page.blocks[group];
    if (block?.type === "heading" || (block?.kind && block.kind !== "verse")) continue;
    for (const line of entries) {
      const prefix = /^(\d+)\s+(?=[^\n]*\p{L})/u.exec(line.text.trim());
      const text = prefix?.[1];
      if (!text || Number(text) <= 0 || Number(text) % 5 !== 0) continue;
      const [left, top, right, bottom] = line.box;
      if (right - left > 450) continue;
      const height = bottom - top;
      // A hanging margin token sits left of nearby verse starts, not at the normal text indent.
      const starts = lines.filter((other) => other.id !== line.id && !/^\s*\d/.test(other.text)
        && other.box[0] - left >= 12 && other.box[0] - left <= 60
        && other.box[2] - other.box[0] <= 450
        && Math.abs(other.box[1] - top) >= height * 0.6 && Math.abs(other.box[1] - top) <= height * 6)
        .map((other) => other.box[0]).sort((a, b) => a - b);
      const margin = starts[Math.floor(starts.length / 2)];
      if (starts.length >= 2 && margin !== undefined) counters.set(line.id, { text, margin });
    }
  }
  const blocks = page.blocks.map((block, index) => {
    const edits: RemovedVerseCounter[] = [];
    for (const match of native?.blocks[index]?.words ?? []) {
      if (match.indices.length !== 1) continue;
      const word = native?.words[match.indices[0] ?? -1];
      if (!word) continue;
      const counter = counters.get(word.line);
      if (!counter || word.text !== counter.text || block.text.slice(match.start, match.end) !== counter.text) continue;
      if (word.box[2] / geometry.w * 1000 >= counter.margin - 2) continue;
      edits.push({ block: index, lineId: word.line, text: counter.text, start: match.start, end: match.end, box: word.box });
    }
    let text = block.text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + text.slice(edit.end).replace(/^[ \t]+/, "");
    }
    removed.push(...edits.reverse());
    return { ...block, text };
  });
  return { page: { ...page, blocks }, removed };
}
