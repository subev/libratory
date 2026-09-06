import type { FlatBlock } from "./marker.ts";
import { countWords } from "./pdf-raw-text.ts";

export type TocEntry = { title: string; page: number | null; level: number | null };
export type HeadingCatalogEntry = { id: string; blockIndex: number; page: number; level: number | null; text: string; words: number };
export type PageAnchor = { printed: number; pdf: number };
export type PageMap = { expected: (printed: number) => number; anchored: (printed: number) => boolean; anchors: PageAnchor[]; summary: string };
export type ChapterEntry = { index: number; titles: string[]; page: number | null };
export type Located = { entry: number; blockIndex: number };
export type Unresolved = { entry: number; expectedPage: number | null; candidates: HeadingCatalogEntry[] };

const MAX_OFFSET_DRIFT = 4;
const MIN_ANCHORS = 3;
const ANCHOR_SIMILARITY = 0.75;
const MATCH_SIMILARITY = 0.6;
const MAX_CANDIDATES = 12;

export function cumulativeWords(blocks: FlatBlock[]): { before: number[]; total: number } {
  const before: number[] = [];
  let total = 0;
  for (const b of blocks) {
    before.push(total);
    if (b.included) total += countWords(b.text);
  }
  return { before, total };
}

function titleTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length >= 2 || /\p{N}/u.test(t));
}

// Recall over the printed title: OCR adds junk to a heading far more often than it drops words
export function titleSimilarity(entryTitle: string, headingText: string): number {
  const t = [...new Set(titleTokens(entryTitle))];
  const h = new Set(titleTokens(headingText));
  if (t.length === 0) return 0;
  const overlap = t.filter((w) => h.has(w)).length;
  if (t.length === 1) return overlap === 1 && h.size <= 3 ? 1 : 0;
  const sim = overlap / t.length;
  return h.size > 2 * t.length + 3 ? sim * 0.6 : sim;
}

type Ranked = { heading: HeadingCatalogEntry; sim: number };

// A heading may agree with the printed title or the model's cleaned one ("Chapter 1" vs "Chapter One")
function ranked(titles: string[], pool: HeadingCatalogEntry[]): Ranked[] {
  return pool
    .map((heading) => ({ heading, sim: Math.max(...titles.map((t) => titleSimilarity(t, heading.text))) }))
    .filter((c) => c.sim > 0)
    .sort((a, b) => b.sim - a.sim);
}

function unambiguous(best: Ranked, second: Ranked | undefined, margin: number) {
  return !second || second.sim <= best.sim - margin || second.heading.page === best.heading.page;
}

export function findAnchors(entries: TocEntry[], catalog: HeadingCatalogEntry[]): PageAnchor[] {
  const anchors: PageAnchor[] = [];
  for (const entry of entries) {
    if (entry.page === null || titleTokens(entry.title).length < 2) continue;
    const [best, second] = ranked([entry.title], catalog);
    if (!best || best.sim < ANCHOR_SIMILARITY || !unambiguous(best, second, 0.25)) continue;
    anchors.push({ printed: entry.page, pdf: best.heading.page });
  }
  return anchors;
}

// Longest chain with non-decreasing PDF pages and bounded offset drift: missing scan pages drift, an index match jumps
export function buildPageMap(anchors: PageAnchor[]): PageMap | null {
  const sorted = [...anchors].sort((a, b) => a.printed - b.printed || a.pdf - b.pdf);
  if (sorted.length < MIN_ANCHORS) return null;
  const best = sorted.map(() => 1);
  const prev = sorted.map(() => -1);
  sorted.forEach((b, j) => {
    sorted.slice(0, j).forEach((a, i) => {
      if (b.pdf < a.pdf || Math.abs(b.pdf - b.printed - (a.pdf - a.printed)) > MAX_OFFSET_DRIFT) return;
      const score = (best[i] ?? 1) + 1;
      if (score > (best[j] ?? 1)) {
        best[j] = score;
        prev[j] = i;
      }
    });
  });
  let end = 0;
  best.forEach((score, j) => {
    if (score > (best[end] ?? 0)) end = j;
  });
  const chain: PageAnchor[] = [];
  for (let k = end; k >= 0; k = prev[k] ?? -1) {
    const anchor = sorted[k];
    if (!anchor) break;
    chain.unshift(anchor);
  }
  const first = chain[0];
  const last = chain[chain.length - 1];
  if (!first || !last || chain.length < MIN_ANCHORS) return null;

  const expected = (printed: number) => {
    let nearest = first;
    for (const a of chain) {
      if (a.printed > printed) break;
      nearest = a;
    }
    return printed + (nearest.pdf - nearest.printed);
  };
  // Outside the anchored span the offset is extrapolated, and front matter often restarts numbering
  const anchored = (printed: number) => printed >= first.printed && printed <= last.printed;
  return { expected, anchored, anchors: chain, summary: summarizeOffsets(chain) };
}

function summarizeOffsets(chain: PageAnchor[]): string {
  const runs: { offset: number; from: number; to: number }[] = [];
  for (const a of chain) {
    const offset = a.pdf - a.printed;
    const current = runs[runs.length - 1];
    if (current && current.offset === offset) current.to = a.printed;
    else runs.push({ offset, from: a.printed, to: a.printed });
  }
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const head = runs[0];
  const tail = runs[runs.length - 1];
  if (!head || !tail) return "";
  if (runs.length === 1) return sign(head.offset);
  if (runs.length > 3) return `${sign(head.offset)} at p${head.from} drifting to ${sign(tail.offset)} at p${tail.from}`;
  return runs.map((r, i) => `${sign(r.offset)} (p${r.from}${i === runs.length - 1 ? "+" : `–${r.to}`})`).join(", ");
}

function nearPage(catalog: HeadingCatalogEntry[], page: number, radius: number): HeadingCatalogEntry[] {
  return catalog.filter((h) => Math.abs(h.page - page) <= radius);
}

function windowAround(catalog: HeadingCatalogEntry[], page: number, anchored: boolean): HeadingCatalogEntry[] {
  const [near, far] = anchored ? [2, 4] : [4, 6];
  const close = nearPage(catalog, page, near);
  return close.length >= 2 ? close : nearPage(catalog, page, far);
}

export function locateEntries(entries: ChapterEntry[], catalog: HeadingCatalogEntry[], pageMap: PageMap | null): { located: Located[]; unresolved: Unresolved[] } {
  const located: Located[] = [];
  const unresolved: Unresolved[] = [];
  let lastBlock = -1;

  for (const entry of entries) {
    const printedPage = entry.page;
    const expected = printedPage !== null && pageMap ? { page: pageMap.expected(printedPage), anchored: pageMap.anchored(printedPage) } : null;
    const pool = expected ? windowAround(catalog, expected.page, expected.anchored) : catalog;
    const open = pool.filter((h) => h.blockIndex > lastBlock);
    const scored = ranked(entry.titles, open);
    const [best, second] = scored;
    const threshold = expected ? MATCH_SIMILARITY : ANCHOR_SIMILARITY;
    if (best && best.sim >= threshold && unambiguous(best, second, 0.15)) {
      located.push({ entry: entry.index, blockIndex: best.heading.blockIndex });
      lastBlock = best.heading.blockIndex;
      continue;
    }
    const bySimilarity = scored.slice(0, MAX_CANDIDATES).map((c) => c.heading);
    const candidates =
      expected || bySimilarity.length === 0
        ? open.slice(0, MAX_CANDIDATES)
        : bySimilarity.sort((a, b) => a.blockIndex - b.blockIndex);
    unresolved.push({ entry: entry.index, expectedPage: expected?.page ?? null, candidates });
  }
  return { located, unresolved };
}
