export type ChunkDraft = {
  text: string;
  charStart: number;
  charEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
};

const TARGET_CHARS = 1400;
const OVERLAP_WINDOW = 250;

type Bounds = { start: number; end: number };

function lastSentenceBreak(window: string): number {
  return Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf(".\n"),
    window.lastIndexOf("!\n"),
    window.lastIndexOf("?\n"),
  );
}

function splitOversized(text: string, start: number, end: number): Bounds[] {
  if (end - start <= TARGET_CHARS) return [{ start, end }];
  const out: Bounds[] = [];
  let pos = start;
  while (end - pos > TARGET_CHARS) {
    const window = text.slice(pos, pos + TARGET_CHARS);
    const breakAt = lastSentenceBreak(window);
    const cut = breakAt > TARGET_CHARS / 2 ? breakAt + 1 : TARGET_CHARS;
    out.push({ start: pos, end: pos + cut });
    pos += cut;
  }
  if (end > pos) out.push({ start: pos, end });
  return out;
}

// Paragraph/page-break separated segments, each at most TARGET_CHARS, with true offsets
function segments(text: string): Bounds[] {
  const out: Bounds[] = [];
  const sep = /(?:\n\s*\n|\f)+/g;
  let last = 0;
  for (const m of text.matchAll(sep)) {
    if (m.index > last) out.push(...splitOversized(text, last, m.index));
    last = m.index + m[0].length;
  }
  if (text.length > last) out.push(...splitOversized(text, last, text.length));
  return out.filter((b) => text.slice(b.start, b.end).trim().length > 0);
}

function pack(segs: Bounds[]): Bounds[] {
  const out: Bounds[] = [];
  let cur: Bounds | null = null;
  for (const s of segs) {
    if (cur && s.end - cur.start > TARGET_CHARS) {
      out.push(cur);
      cur = null;
    }
    cur = cur ? { start: cur.start, end: s.end } : { ...s };
  }
  if (cur) out.push(cur);
  return out;
}

// Extends a chunk's start backward to a sentence boundary inside the previous
// chunk, so retrieval hits keep their lead-in context. Offsets stay true.
function overlapStart(text: string, boundary: number): number {
  const from = Math.max(0, boundary - OVERLAP_WINDOW);
  const window = text.slice(from, boundary);
  const breakAt = lastSentenceBreak(window);
  return breakAt >= 0 ? from + breakAt + 2 : boundary;
}

function finalize(text: string, bounds: Bounds[], pageOf: ((offset: number) => number) | null): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  for (const [i, bound] of bounds.entries()) {
    const start = i === 0 ? bound.start : overlapStart(text, bound.start);
    const end = bound.end;
    const slice = text.slice(start, end);
    const leading = slice.length - slice.trimStart().length;
    const trailing = slice.length - slice.trimEnd().length;
    const charStart = start + leading;
    const charEnd = end - trailing;
    if (charEnd <= charStart) continue;
    out.push({
      text: text.slice(charStart, charEnd).replace(/\f/g, "\n"),
      charStart,
      charEnd,
      pageStart: pageOf ? pageOf(charStart) : null,
      pageEnd: pageOf ? pageOf(charEnd - 1) : null,
    });
  }
  return out;
}

// For pdftotext output: \f separates pages, so page N+1 starts after the Nth \f
export function chunkPagedText(rawText: string): ChunkDraft[] {
  const feeds: number[] = [];
  for (let i = rawText.indexOf("\f"); i !== -1; i = rawText.indexOf("\f", i + 1)) feeds.push(i);
  const pageOf = (offset: number): number => {
    let lo = 0;
    let hi = feeds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((feeds[mid] ?? Number.POSITIVE_INFINITY) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  return finalize(rawText, pack(segments(rawText)), feeds.length > 0 ? pageOf : null);
}

export function chunkPlainText(
  text: string,
  pageStart: number | null = null,
  pageEnd: number | null = null,
  pageOf: ((offset: number) => number) | null = null,
): ChunkDraft[] {
  const drafts = finalize(text, pack(segments(text)), pageOf);
  return pageOf ? drafts : drafts.map((c) => ({ ...c, pageStart, pageEnd }));
}

export type PageBlock = { text: string; page: number; included: boolean };

// Marker source blocks → offset→page map over the chapter text they were joined
// into. Blocks are located by prefix in order; ones that no longer match the
// (possibly cleaned) text are skipped, so the map degrades instead of breaking.
export function pageMapFromBlocks(text: string, blocks: PageBlock[]): ((offset: number) => number) | null {
  const marks: Array<{ offset: number; page: number }> = [];
  let cursor = 0;
  for (const block of blocks) {
    if (!block.included) continue;
    const probe = block.text.trim().slice(0, 64);
    if (!probe) continue;
    const idx = text.indexOf(probe, cursor);
    if (idx === -1) continue;
    if (block.page !== marks.at(-1)?.page) {
      marks.push({ offset: idx, page: block.page });
    }
    cursor = idx + probe.length;
  }
  if (marks.length === 0) return null;
  return (offset: number): number => {
    let lo = 0;
    let hi = marks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((marks[mid]?.offset ?? Number.POSITIVE_INFINITY) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return marks[lo]?.page ?? 1;
  };
}
