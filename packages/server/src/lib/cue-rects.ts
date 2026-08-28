import type { ChapterTextMap } from "../schema.ts";
import type { SourceBlock } from "./marker.ts";
import type { GeometryLine, GeometryPage } from "./page-geometry.ts";

// [page, x, y, w, h]: flat page index, then ten-thousandths of the page box, origin top-left
export type CueRect = [number, number, number, number, number];

export type RectContext = {
  cleanText: string;
  textMap: ChapterTextMap;
  blocks: SourceBlock[];
  // Flat page index and geometry for a source block's own page number
  page: (blockPage: number) => { index: number; geometry: GeometryPage | null } | null;
};

const MAX_RECTS = 4;
// A line whose middle sits inside the block, allowing for polygon rounding
const CONTAINMENT_SLACK = 2;

// linesOnly: give nothing rather than the paragraph box. A word-sized highlight that degrades
// to a whole block is worse than no highlight, and punctuation has no place on the page at all.
export function rectsForRange(
  context: RectContext,
  start: number,
  end: number,
  { linesOnly = false } = {},
): CueRect[] {
  const perBlock: CueRect[][] = [];

  for (const span of context.textMap.spans) {
    if (span.end <= start || end <= span.start) continue;
    const block = context.blocks[span.block];
    const page = block ? context.page(block.page) : null;
    if (!block || !page) continue;

    // Without the page's own size there is nothing to normalize against, so no rect is offered
    const box = polygonBox(block.polygon);
    if (!page.geometry || !box) continue;

    const aligned = alignment(context, span.block, page.geometry, box, context.cleanText.slice(span.start, span.end));
    const from = Math.max(start, span.start) - span.start;
    const to = Math.min(end, span.end) - span.start;
    const rects = (aligned && rectsFromLines(aligned, from, to)) ?? (linesOnly ? null : [box]);
    if (rects) perBlock.push(rects.map((rect) => normalize(page.index, rect, page.geometry!)));
  }

  return capRects(perBlock);
}

type Box = [number, number, number, number];

function polygonBox(polygon: number[][] | undefined): Box | null {
  const xs = polygon?.map((point) => point[0]).filter((v) => v !== undefined) ?? [];
  const ys = polygon?.map((point) => point[1]).filter((v) => v !== undefined) ?? [];
  if (xs.length === 0 || ys.length === 0) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

type BlockAlignment = {
  lines: GeometryLine[];
  origin: { line: number; column: number }[];
  // projected block character -> character of the joined line text, -1 where it has no counterpart
  map: number[];
  blockMap: number[];
};

// One alignment per block, reused by every cue and word that lands in it
const alignments = new WeakMap<RectContext, Map<number, BlockAlignment | null>>();

function alignment(
  context: RectContext,
  blockIndex: number,
  page: GeometryPage,
  box: Box,
  blockText: string,
): BlockAlignment | null {
  let byBlock = alignments.get(context);
  if (!byBlock) {
    byBlock = new Map();
    alignments.set(context, byBlock);
  }
  if (byBlock.has(blockIndex)) return byBlock.get(blockIndex)!;

  const lines = page.lines.filter((line) => centreInside(line.b, box));
  const joined = lines.length > 0 ? joinLines(lines) : null;
  const built = joined
    ? (() => {
        const block = project(blockText);
        const linesProjection = project(joined.text);
        const aligned = alignProjections(block.value, linesProjection.value);
        // A block whose text barely appears in the lines under it was not really found there.
        // Measured against the shorter side, so a block only some of whose lines were located
        // still counts as found.
        const matched = aligned.filter((at) => at !== -1).length;
        const comparable = Math.min(block.value.length, linesProjection.value.length);
        if (matched < comparable * MIN_ALIGNMENT) return null;

        const map = aligned.map((at) => (at === -1 ? -1 : (linesProjection.map[at] ?? -1)));
        return { lines, origin: joined.origin, map, blockMap: block.map };
      })()
    : null;

  byBlock.set(blockIndex, built);
  return built;
}

// The block's text and the page's own lines are the same content reached two different ways, so
// they differ in punctuation, markdown and hyphen joins but never in order. Walking both once
// and resynchronising on mismatch gives a mapping that only ever moves forward — which is what
// stops a repeated word like "the" from being placed at an earlier one of its occurrences.
const RESYNC_KEY = 8;
const RESYNC_WINDOW = 64;
const MIN_ALIGNMENT = 0.6;

function alignProjections(block: string, lines: string): number[] {
  const map: number[] = Array.from({ length: block.length }, () => -1);
  let i = 0;
  let j = 0;

  while (i < block.length && j < lines.length) {
    if (block[i] === lines[j]) {
      map[i] = j;
      i++;
      j++;
      continue;
    }
    const at = lines.indexOf(block.slice(i, i + RESYNC_KEY), j);
    if (at !== -1 && at - j <= RESYNC_WINDOW) j = at;
    else i++;
  }

  return map;
}

function rectsFromLines(aligned: BlockAlignment, from: number, to: number): Box[] | null {
  const start = projectedIndex(aligned.blockMap, from);
  const end = projectedIndex(aligned.blockMap, to);

  let first = -1;
  let last = -1;
  for (let i = start; i < end; i++) {
    const at = aligned.map[i];
    if (at !== undefined && at !== -1) { first = at; break; }
  }
  for (let i = end - 1; i >= start; i--) {
    const at = aligned.map[i];
    if (at !== undefined && at !== -1) { last = at; break; }
  }
  if (first === -1 || last < first) return null;

  const spans = new Map<number, { from: number; to: number }>();
  for (let i = first; i <= last; i++) {
    const at = aligned.origin[i];
    if (!at) continue;
    const current = spans.get(at.line);
    if (current) current.to = at.column + 1;
    else spans.set(at.line, { from: at.column, to: at.column + 1 });
  }

  const rects = [...spans.entries()].flatMap(([index, span]) => {
    const line = aligned.lines[index];
    return line ? [lineRect(line, span.from, span.to)] : [];
  });
  const [head, ...rest] = rects;
  const tail = rest.at(-1);
  if (rects.length <= 3 || !head || !tail) return rects;

  // The shape a text selection takes: partial first line, solid middle, partial last line
  return [head, unionBox(rest.slice(0, -1)), tail];
}

function centreInside(line: GeometryLine["b"], box: Box): boolean {
  const x = (line[0] + line[2]) / 2;
  const y = (line[1] + line[3]) / 2;
  return (
    x >= box[0] - CONTAINMENT_SLACK && x <= box[2] + CONTAINMENT_SLACK &&
    y >= box[1] - CONTAINMENT_SLACK && y <= box[3] + CONTAINMENT_SLACK
  );
}

function lineRect(line: GeometryLine, from: number, to: number): Box {
  const xs = line.xs;
  const x0 = xs?.[Math.min(from, xs.length - 1)];
  const x1 = xs?.[Math.min(to, xs.length - 1)];
  if (from >= to || x0 === undefined || x1 === undefined) return [line.b[0], line.b[1], line.b[2], line.b[3]];
  return [Math.min(x0, x1), line.b[1], Math.max(x0, x1), line.b[3]];
}

function joinLines(lines: GeometryLine[]): { text: string; origin: { line: number; column: number }[] } {
  let text = "";
  const origin: { line: number; column: number }[] = [];
  for (const [line, { t }] of lines.entries()) {
    for (let column = 0; column < t.length; column++) {
      text += t[column] ?? "";
      origin.push({ line, column });
    }
  }
  return { text, origin };
}

// Projected characters before this offset of the source string
function projectedIndex(map: number[], sourceIndex: number): number {
  let low = 0;
  let high = map.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((map[mid] ?? Number.POSITIVE_INFINITY) < sourceIndex) low = mid + 1;
    else high = mid;
  }
  return low;
}


function project(text: string): { value: string; map: number[] } {
  let value = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!ch || !/[\p{L}\p{N}]/u.test(ch)) continue;
    value += ch.toLowerCase();
    map.push(i);
  }
  return { value, map };
}

function unionBox(boxes: Box[]): Box {
  const [head] = boxes;
  if (!head) return [0, 0, 0, 0];
  let [x0, y0, x1, y1] = head;
  for (const box of boxes) {
    x0 = Math.min(x0, box[0]);
    y0 = Math.min(y0, box[1]);
    x1 = Math.max(x1, box[2]);
    y1 = Math.max(y1, box[3]);
  }
  return [x0, y0, x1, y1];
}

function normalize(page: number, box: Box, geometry: GeometryPage): CueRect {
  const width = geometry.w || 1;
  const height = geometry.h || 1;
  const to = (value: number, size: number) => Math.max(0, Math.min(10_000, Math.round((value / size) * 10_000)));
  const x = to(box[0], width);
  const y = to(box[1], height);
  return [page, x, y, to(box[2], width) - x, to(box[3], height) - y];
}

// Past the cap a cue degrades to a box per block, then to one per page — coarser, never wrong
function capRects(perBlock: CueRect[][]): CueRect[] {
  const all = perBlock.flat();
  if (all.length <= MAX_RECTS) return all;

  const perBlockBoxes = perBlock.map((rects) => coverRects(rects));
  if (perBlockBoxes.length <= MAX_RECTS) return perBlockBoxes;

  const byPage = new Map<number, CueRect[]>();
  for (const rect of perBlockBoxes) byPage.set(rect[0], [...(byPage.get(rect[0]) ?? []), rect]);
  return [...byPage.values()].map((rects) => coverRects(rects)).slice(0, MAX_RECTS);
}

function coverRects(rects: CueRect[]): CueRect {
  const box = unionBox(rects.map((rect) => [rect[1], rect[2], rect[1] + rect[3], rect[2] + rect[4]]));
  return [rects[0]?.[0] ?? 0, box[0], box[1], box[2] - box[0], box[3] - box[1]];
}
