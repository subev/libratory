import { diffArrays, type ArrayChange } from "diff";

import { similarity } from "./word-alignment.ts";

// Lines an edited text up with the text it was edited from, word by word, so that what is
// known about the original — which block a span sits in, which line of the page — can be asked
// about the edited text. A fixed misread lands on the misread's own box; a dropped page number
// maps to nothing; words typed in have nowhere to go and say so.

export type Span = [start: number, end: number];

export type TextAlignment = {
  // Share of the edited text's words that the original has unchanged, 0..1
  fit: number;
  // The original's span under an edited span: null when nothing there was kept
  toOriginal(start: number, end: number): Span | null;
  // The edited span an original span survives as: null when it was deleted
  toEdited(start: number, end: number): Span | null;
};

// Below this the edit replaced the text rather than correcting it, and the original's
// geometry says nothing about what is spoken now
export const KEPT = 0.6;

type Token = { start: number; end: number; key: string };

// Words are runs of non-whitespace, compared by their letters and digits alone and spanning only
// those — case, punctuation, quotes and hyphens are what an edit most often touches without
// touching the word, and a word's box on the page does not hold its comma either
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    let first = -1;
    let last = -1;
    let at = 0;
    for (const ch of word) {
      if (/[\p{L}\p{N}]/u.test(ch)) {
        if (first === -1) first = at;
        last = at + ch.length;
      }
      at += ch.length;
    }
    if (first === -1) continue;
    const key = word.normalize("NFD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    tokens.push({ start: match.index + first, end: match.index + last, key });
  }
  return tokens;
}

type Options = { timeoutMs?: number };

// null when the texts are too far apart to be worth lining up: past the edit distance at which
// fit would fall under KEPT anyway, or past the time a manifest can afford
export function alignTexts(edited: string, original: string, { timeoutMs = 10_000 }: Options = {}): TextAlignment | null {
  const from = tokenize(edited);
  const to = tokenize(original);
  if (from.length === 0 || to.length === 0) return null;

  // D = |edited| + |original| − 2·equal, and fit = equal / |edited|
  const maxEditLength = Math.floor(from.length + to.length - 2 * KEPT * from.length);
  if (maxEditLength < 0) return null;

  const changes = anchoredDiff(to.map((t) => t.key), from.map((t) => t.key), maxEditLength, Date.now() + timeoutMs);
  if (!changes) return null;

  const forward: (Span | null)[] = Array.from({ length: from.length }, () => null);
  const backward: (Span | null)[] = Array.from({ length: to.length }, () => null);
  let i = 0;
  let j = 0;
  let equal = 0;
  // The removed and added words since the last equal run: together, a replacement
  const hunk = { removed: 0, added: 0 };

  const closeHunk = () => {
    if (hunk.removed > 0 && hunk.added > 0) {
      pairReplaced(from.slice(i - hunk.added, i), to.slice(j - hunk.removed, j), forward, backward, i - hunk.added, j - hunk.removed);
    }
    hunk.removed = 0;
    hunk.added = 0;
  };

  for (const change of changes) {
    if (change.added) {
      hunk.added += change.count;
      i += change.count;
    } else if (change.removed) {
      hunk.removed += change.count;
      j += change.count;
    } else {
      closeHunk();
      for (let k = 0; k < change.count; k++) {
        forward[i + k] = spanOf(to, j + k, 1);
        backward[j + k] = spanOf(from, i + k, 1);
      }
      i += change.count;
      j += change.count;
      equal += change.count;
    }
  }
  closeHunk();

  return {
    fit: equal / from.length,
    toOriginal: (start, end) => mapSpan(from, forward, start, end),
    toEdited: (start, end) => mapSpan(to, backward, start, end),
  };
}

// Myers' cost grows with the square of the edit count, and a cleanup pass over a long chapter is
// thousands of one-letter edits scattered through tens of thousands of words. A run of three
// words that occurs once in each text is the same place in both, so the texts are pinned at
// every such run and only the stretches between them are diffed — each a few words long, however
// long the chapter. An edit never reorders, so a chain of anchors in order on both sides is the
// alignment, and the longest such chain is what keeps a coincidence from pinning the wrong place.
const ANCHOR = 3;

function anchoredDiff(old: string[], now: string[], maxEditLength: number, deadline: number): ArrayChange<string>[] | undefined {
  const changes: ArrayChange<string>[] = [];
  let budget = maxEditLength;
  let oldAt = 0;
  let nowAt = 0;

  for (const [oldIndex, nowIndex] of anchors(old, now)) {
    const between = segment(old.slice(oldAt, oldIndex), now.slice(nowAt, nowIndex));
    if (!between) return undefined;
    changes.push(...between);
    changes.push({ value: [old[oldIndex]!], count: 1, added: false, removed: false });
    oldAt = oldIndex + 1;
    nowAt = nowIndex + 1;
  }
  const tail = segment(old.slice(oldAt), now.slice(nowAt));
  if (!tail) return undefined;
  changes.push(...tail);
  return changes;

  function segment(a: string[], b: string[]): ArrayChange<string>[] | undefined {
    if (a.length === 0 && b.length === 0) return [];
    if (Date.now() > deadline) return undefined;
    const part = diffArrays(a, b, { maxEditLength: budget });
    if (!part) return undefined;
    for (const change of part) if (change.added || change.removed) budget -= change.count;
    return part;
  }
}

// Runs of ANCHOR words unique to both texts, as index pairs rising on both sides
function anchors(old: string[], now: string[]): [number, number][] {
  const once = (keys: string[]) => {
    const seen = new Map<string, number>();
    for (let i = 0; i + ANCHOR <= keys.length; i++) {
      const run = keys.slice(i, i + ANCHOR).join("\u0000");
      seen.set(run, seen.has(run) ? -1 : i);
    }
    return seen;
  };
  const inOld = once(old);
  const inNow = once(now);
  const pairs: [number, number][] = [];
  for (const [run, nowIndex] of inNow) {
    const oldIndex = inOld.get(run);
    if (nowIndex !== -1 && oldIndex !== undefined && oldIndex !== -1) pairs.push([oldIndex, nowIndex]);
  }
  pairs.sort((a, b) => a[1] - b[1]);
  return longestRisingChain(pairs);
}

// Patience sorting over the old-side indices of pairs already in order on the new side
function longestRisingChain(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const previous: number[] = Array.from({ length: pairs.length }, () => -1);
  const tailAt: number[] = [];
  pairs.forEach(([oldIndex], at) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid]! < oldIndex) low = mid + 1;
      else high = mid;
    }
    tails[low] = oldIndex;
    tailAt[low] = at;
    previous[at] = low > 0 ? tailAt[low - 1]! : -1;
  });
  const chain: [number, number][] = [];
  for (let at = tailAt[tails.length - 1] ?? -1; at !== -1; at = previous[at]!) chain.push(pairs[at]!);
  return chain.reverse();
}

// How alike a corrected word and its misread have to be: one letter in a three-letter word
const CORRECTED = 0.5;
// A word the print broke into pieces — a hyphenated line end, spaced-out capitals — is one
// edited word against a run of original ones, and the run has to read as the word
const JOINED = 0.7;
const MAX_RUN = 6;
const LOOKAHEAD = 16;

// Inside a replacement, each edited word takes the original word (or run of words) it most
// resembles, in order. What resembles nothing stands for the whole replacement, since which
// corrected word was which misread is not something a word count can tell; original words that
// nothing claims — a page number, scanning noise — were dropped and go nowhere.
function pairReplaced(added: Token[], removed: Token[], forward: (Span | null)[], backward: (Span | null)[], addedAt: number, removedAt: number) {
  const whole: Span = [removed[0]!.start, removed[removed.length - 1]!.end];
  let next = 0;
  added.forEach((word, a) => {
    let best: { start: number; length: number; score: number } | null = null;
    for (let start = next; start < Math.min(removed.length, next + LOOKAHEAD); start++) {
      let key = "";
      for (let length = 1; length <= MAX_RUN && start + length <= removed.length; length++) {
        key += removed[start + length - 1]!.key;
        const score = similarity(word.key, key);
        if (score < (length === 1 ? CORRECTED : JOINED)) continue;
        if (!best || score > best.score) best = { start, length, score };
      }
    }
    if (!best) {
      forward[addedAt + a] = whole;
      return;
    }
    forward[addedAt + a] = spanOf(removed, best.start, best.length);
    for (let k = best.start; k < best.start + best.length; k++) backward[removedAt + k] = spanOf(added, a, 1);
    next = best.start + best.length;
  });
}

function spanOf(tokens: Token[], at: number, length: number): Span {
  return [tokens[at]!.start, tokens[at + length - 1]!.end];
}

// The words a span touches, mapped, as one span: the diff never reorders, so the first and last
// mapped word bound everything between them
function mapSpan(tokens: Token[], map: (Span | null)[], start: number, end: number): Span | null {
  let first = -1;
  let last = -1;
  for (let k = firstTokenEndingAfter(tokens, start); k < tokens.length && tokens[k]!.start < end; k++) {
    const mapped = map[k];
    if (!mapped) continue;
    if (first === -1 || mapped[0] < first) first = mapped[0];
    if (mapped[1] > last) last = mapped[1];
  }
  return first === -1 ? null : [first, last];
}

function firstTokenEndingAfter(tokens: Token[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tokens[mid]!.end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}
