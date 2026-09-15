import type { OcrWord } from "./ocr-tesseract.ts";

// Marries a vision model's clean text to a local OCR's word boxes. The model reads words and gives
// no positions; Tesseract gives a box for every word it saw and misreads some. Aligned as two
// sequences in reading order, each model word takes the box of its OCR partner — the order is
// what tells one "на" from the next, which a bag-of-words lookup cannot.

export type Box = [number, number, number, number];

export type PlacedWord = {
  text: string;
  block: number;
  /** In the OCR's pixels; null when nothing on the page could place it */
  box: Box | null;
  /** True when an OCR word was found for it, false when the box is guessed from its neighbours */
  matched: boolean;
  /** How alike the OCR partner was, MATCH..1; absent when guessed */
  score?: number;
};

export type Placement = {
  words: PlacedWord[];
  /** The bounding box of each block's placed words, by block index */
  blockBoxes: (Box | null)[];
  /** Share of the model's words that found an OCR partner; null when there were no words */
  matchedShare: number | null;
  /** Matched words the two readers spell differently: the model's misreads are among these, and nothing else sees them */
  doubtful: string[];
};

// Normalised Levenshtein similarity two tokens need to count as the same word. 0.7 lets a
// one-letter misread pass on a four-letter word and none on a three-letter one.
export const MATCH = 0.7;
const GAP = -0.3;
// Below this a match is a disagreement worth naming: one letter in a six-letter word
export const DOUBT = 0.85;

function key(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// A token with no letters or digits — the dash that opens a line of dialogue, a stray quote —
// carries nothing to match on; two of them are not the same word, they are two blanks.
function similarity(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  if (a === b) return 1;
  if (Math.abs(n - m) > Math.max(n, m) * (1 - MATCH)) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[m]! / Math.max(n, m);
}

// Tesseract keeps a line-end hyphen on the first half of a split word; the model writes the word whole.
const HYPHEN_END = /[-‐‑¬]$/u;

const enum Move { None, Match, Merge, SkipModel, SkipOcr }

type Aligned = { ocr: number | null; merged: boolean; score: number };

// Needleman–Wunsch over the two word sequences: a match scores its similarity, a word either side
// has to skip costs a little, and one model word may take two OCR words when the first ends in a
// hyphen and the pair reads as the word. Pages are a few hundred words a side, so the table is small.
export function alignWords(model: string[], ocr: OcrWord[]): Aligned[] {
  const n = model.length;
  const m = ocr.length;
  const mk = model.map(key);
  const ok = ocr.map((w) => key(w.text));
  // A hyphenated first half has letters before its hyphen; a bare dash is a word of its own
  const merged = ocr.map((w, j) => {
    if (j + 1 >= m || !HYPHEN_END.test(w.text)) return null;
    const head = key(w.text.replace(HYPHEN_END, ""));
    return head ? key(head + ocr[j + 1]!.text) : null;
  });
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  const back = new Int8Array((n + 1) * width);
  for (let j = 1; j <= m; j++) {
    score[j] = j * GAP;
    back[j] = Move.SkipOcr;
  }
  for (let i = 1; i <= n; i++) {
    score[i * width] = i * GAP;
    back[i * width] = Move.SkipModel;
    for (let j = 1; j <= m; j++) {
      let best = score[(i - 1) * width + j]! + GAP;
      let move = Move.SkipModel;
      const left = score[i * width + j - 1]! + GAP;
      if (left > best) {
        best = left;
        move = Move.SkipOcr;
      }
      const s = similarity(mk[i - 1]!, ok[j - 1]!);
      if (s >= MATCH && score[(i - 1) * width + j - 1]! + s > best) {
        best = score[(i - 1) * width + j - 1]! + s;
        move = Move.Match;
      }
      const pair = j >= 2 ? (merged[j - 2] ?? null) : null;
      if (pair !== null) {
        const s2 = similarity(mk[i - 1]!, pair);
        if (s2 >= MATCH && score[(i - 1) * width + j - 2]! + s2 > best) {
          best = score[(i - 1) * width + j - 2]! + s2;
          move = Move.Merge;
        }
      }
      score[i * width + j] = best;
      back[i * width + j] = move;
    }
  }
  const out: Aligned[] = Array.from({ length: n }, () => ({ ocr: null, merged: false, score: 0 }));
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = back[i * width + j];
    if (move === Move.Match) {
      out[i - 1] = { ocr: j - 1, merged: false, score: similarity(mk[i - 1]!, ok[j - 1]!) };
      i--;
      j--;
    } else if (move === Move.Merge) {
      out[i - 1] = { ocr: j - 2, merged: true, score: similarity(mk[i - 1]!, merged[j - 2]!) };
      i--;
      j -= 2;
    } else if (move === Move.SkipModel) {
      i--;
    } else {
      j--;
    }
  }
  return out;
}

function union(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

type Anchor = { box: Box; line: number; charWidth: number };

/** The OCR image's size in its own pixels; boxes are kept inside it. */
export type Bounds = { width: number; height: number };

// A word the OCR missed sits between its placed neighbours when they share a line. Otherwise it
// goes at that word's own width in a neighbour's letters, on whichever side has room for the run:
// the start of the next placed word's line first — a line beginning the OCR skipped is the common
// case — else the end of the previous one, else the roomier side, squeezed to fit. A run must never
// leave the page, which the viewer sizes to its content.
function guessBoxes(run: PlacedWord[], before: Anchor | null, after: Anchor | null, bounds: Bounds | null, margin: number): void {
  const lengths = run.map((w) => Math.max(1, w.text.length));
  const chars = lengths.reduce((a, l) => a + l, 0) + run.length - 1;
  const fill = (x0: number, x1: number, y0: number, y1: number) => {
    const step = (x1 - x0) / chars;
    let x = x0;
    run.forEach((w, k) => {
      w.box = [x, y0, x + step * lengths[k]!, y1];
      x += step * (lengths[k]! + 1);
    });
  };
  if (before && after && before.line === after.line && after.box[0] > before.box[2]) {
    fill(before.box[2], after.box[0], Math.min(before.box[1], after.box[1]), Math.max(before.box[3], after.box[3]));
    return;
  }
  if (!before && !after) return;
  const rightRoom = before ? (bounds?.width ?? Number.POSITIVE_INFINITY) - before.box[2] : -1;
  const leftRoom = after ? after.box[0] - margin : -1;
  const natural = (anchor: Anchor) => anchor.charWidth * (chars + 1);
  const useAfter = !before || (after !== null && (leftRoom >= natural(after) || (rightRoom < natural(before) && leftRoom > rightRoom)));
  if (useAfter && after) {
    const cw = after.charWidth;
    const room = after.box[0];
    if (natural(after) > room) fill(0, Math.max(0, after.box[0] - Math.min(cw, room / (chars + 1))), after.box[1], after.box[3]);
    else fill(after.box[0] - natural(after), after.box[0] - cw, after.box[1], after.box[3]);
  } else if (before) {
    const cw = before.charWidth;
    const room = rightRoom;
    if (natural(before) > room) fill(before.box[2] + Math.min(cw, room / (chars + 1)), before.box[2] + room, before.box[1], before.box[3]);
    else fill(before.box[2] + cw, before.box[2] + natural(before), before.box[1], before.box[3]);
  }
}

/** Places every whitespace-separated word of each block's text on the OCR's boxes. */
export function placeBlocks(blockTexts: string[], ocr: OcrWord[], bounds: Bounds | null = null): Placement {
  const words: PlacedWord[] = blockTexts.flatMap((text, block) => text.split(/\s+/).filter(Boolean).map((t) => ({ text: t, block, box: null, matched: false })));
  const aligned = ocr.length ? alignWords(words.map((w) => w.text), ocr) : [];
  const anchors: (Anchor | null)[] = words.map(() => null);
  aligned.forEach((a, i) => {
    if (a.ocr === null) return;
    const first = ocr[a.ocr]!;
    const second = a.merged ? ocr[a.ocr + 1] : undefined;
    const box = second && second.line === first.line ? union(first.box, second.box) : first.box;
    words[i]!.box = box;
    words[i]!.matched = true;
    words[i]!.score = a.score;
    const letters = first.text.length + (second?.text.length ?? 0);
    const ink = second ? first.box[2] - first.box[0] + (second.box[2] - second.box[0]) : first.box[2] - first.box[0];
    anchors[i] = { box, line: first.line, charWidth: ink / Math.max(1, letters) };
  });

  // The page's left margin, which decides whether a skipped run fits at the start of a line
  const margin = ocr.length ? Math.max(0, Math.min(...ocr.map((w) => w.box[0]))) : 0;
  let start = 0;
  while (start < words.length) {
    if (words[start]!.matched) {
      start++;
      continue;
    }
    let end = start;
    while (end < words.length && !words[end]!.matched) end++;
    guessBoxes(words.slice(start, end), anchors[start - 1] ?? null, anchors[end] ?? null, bounds, margin);
    start = end;
  }

  const blockBoxes: (Box | null)[] = blockTexts.map(() => null);
  for (const w of words) {
    if (!w.box) continue;
    if (bounds && !w.matched) {
      const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
      w.box = [clamp(w.box[0], bounds.width), clamp(w.box[1], bounds.height), clamp(w.box[2], bounds.width), clamp(w.box[3], bounds.height)];
    }
    const current = blockBoxes[w.block];
    blockBoxes[w.block] = current ? union(current, w.box) : w.box;
  }
  const matched = words.filter((w) => w.matched).length;
  const doubtful = words.filter((w) => w.matched && (w.score ?? 1) < DOUBT).map((w) => w.text);
  return { words, blockBoxes, matchedShare: words.length ? matched / words.length : null, doubtful };
}
