import type { OcrWord } from "./ocr-tesseract.ts";

// Marries a vision model's clean text to a local OCR's word boxes. The model reads words and gives
// no positions; Tesseract gives a box for every word it saw and misreads some. Aligned as two
// sequences in reading order, each model word takes the box of its OCR partner — the order is
// what tells one "на" from the next, which a bag-of-words lookup cannot.

export type Box = [number, number, number, number];

export type PlacedWord = {
  text: string;
  block: number;
  start: number;
  end: number;
  box: Box | null;
  indices: number[];
  matched: boolean;
  score?: number;
};

export type Placement = {
  words: PlacedWord[];
  blockBoxes: (Box | null)[];
  matchedShare: number | null;
  doubtful: string[];
};

// Normalised Levenshtein similarity two tokens need to count as the same word. 0.7 lets a
// one-letter misread pass on a four-letter word and none on a three-letter one.
export const MATCH = 0.7;
const GAP = -0.3;
// Below this a match is a disagreement worth naming: one letter in a six-letter word
export const DOUBT = 0.85;

function key(token: string): string {
  return token.normalize("NFD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
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
  let cur = Array.from({ length: m + 1 }, () => 0);
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
export function alignWords(model: string[], ocr: OcrWord[], local = false): Aligned[] {
  const n = model.length;
  const m = ocr.length;
  const mk = model.map(key);
  const ok = ocr.map((w) => key(w.text));
  // A hyphenated first half has letters before its hyphen; a bare dash is a word of its own
  const merged = ocr.map((w, j) => {
    const next = ocr[j + 1];
    if (!next || (next.line !== w.line && !HYPHEN_END.test(w.text))) return null;
    const head = key(w.text);
    return head && key(next.text) ? head + key(next.text) : null;
  });
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  const back = new Int8Array((n + 1) * width);
  for (let j = 1; j <= m; j++) {
    score[j] = local ? 0 : j * GAP;
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
        if ((s2 === 1 || (s2 >= MATCH && HYPHEN_END.test(ocr[j - 2]?.text ?? ""))) && score[(i - 1) * width + j - 2]! + s2 > best) {
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
  if (local) for (let at = 0; at <= m; at++) {
    if ((score[n * width + at] ?? -Infinity) > (score[n * width + j] ?? -Infinity)) j = at;
  }
  while (i > 0 || j > 0) {
    if (local && i === 0) break;
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

export type Bounds = { width: number; height: number };

function units(text: string, keys: Set<string>): { text: string; start: number; end: number }[] {
  const tokens = [...text.matchAll(/\S+/gu)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  const result: { text: string; start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i];
    if (!first) continue;
    let last = i;
    let joined = key(first.text);
    // Spaced headings and split spellings can describe a single measured OCR word.
    for (let j = i + 1; joined && j < Math.min(tokens.length, i + 16); j++) {
      const next = tokens[j];
      if (!next || !key(next.text)) break;
      joined += key(next.text);
      if (keys.has(joined)) last = j;
    }
    const end = tokens[last]?.end ?? first.end;
    result.push({ text: text.slice(first.start, end), start: first.start, end });
    i = last;
  }
  return result;
}

export function placeBlocks(blockTexts: string[], ocr: OcrWord[], bounds: Bounds | null = null): Placement {
  const words: PlacedWord[] = [];
  const used = new Set<number>();
  const blockBoxes: (Box | null)[] = blockTexts.map(() => null);
  for (const [block, text] of blockTexts.entries()) {
    const available = ocr.flatMap((word, index) => !used.has(index) && word.box.every(Number.isFinite)
      && word.box[2] > word.box[0] && word.box[3] > word.box[1]
      && (!bounds || (word.box[0] >= 0 && word.box[1] >= 0 && word.box[2] <= bounds.width && word.box[3] <= bounds.height))
      ? [{ word, index }] : []);
    const tokens = units(text, new Set(available.map(({ word }) => key(word.text))));
    const aligned = alignWords(tokens.map((t) => t.text), available.map((a) => a.word), true);
    for (const [i, token] of tokens.entries()) {
      const hit = aligned[i];
      const first = hit?.ocr == null ? undefined : available[hit.ocr];
      const second = hit?.ocr == null || !hit.merged ? undefined : available[hit.ocr + 1];
      const indices = first ? [first.index, ...(second ? [second.index] : [])] : [];
      const box = first ? (second ? union(first.word.box, second.word.box) : first.word.box) : null;
      indices.forEach((index) => used.add(index));
      words.push({ ...token, block, box, indices, matched: Boolean(first), ...(first ? { score: hit?.score } : {}) });
      const current = blockBoxes[block];
      if (box) blockBoxes[block] = current ? union(current, box) : box;
    }
  }
  const matched = words.filter((w) => w.matched).length;
  return { words, blockBoxes, matchedShare: words.length ? matched / words.length : null,
    doubtful: words.filter((w) => w.matched && (w.score ?? 1) < DOUBT).map((w) => w.text) };
}
