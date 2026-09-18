import type { FlatBlock } from "./marker.ts";
import { countWords } from "./pdf-raw-text.ts";

export type TocEntry = { title: string; page: number | null; level: number | null };
export type HeadingCatalogEntry = { id: string; blockIndex: number; page: number; level: number | null; text: string; words: number };
export type PageAnchor = { entry: number; printed: number; pdf: number };
export type PageMap = { expected: (printed: number) => number; anchored: (printed: number) => boolean; anchors: PageAnchor[]; summary: string };
export type ChapterEntry = { index: number; titles: string[]; page: number | null };
export type Located = { entry: number; blockIndex: number };
export type Unresolved = { entry: number; expectedPage: number | null; candidates: HeadingCatalogEntry[] };

const MAX_OFFSET_DRIFT = 4;
const MIN_ANCHORS = 3;
const ANCHOR_SIMILARITY = 0.75;
const MATCH_SIMILARITY = 0.6;
const MAX_CANDIDATES = 12;
const MAX_ANCHORS_PER_ENTRY = 6;
const MIN_COMPACT_LENGTH = 6;

export function cumulativeWords(blocks: FlatBlock[]): { before: number[]; total: number } {
  const before: number[] = [];
  let total = 0;
  for (const b of blocks) {
    before.push(total);
    if (b.included) total += countWords(b.text);
  }
  return { before, total };
}

// "3. Ethics of Inarticulacy" and "3." in the notes carry the number; the body heading rarely does
function stripNumbering(text: string): string {
  const stripped = text.replace(/^\s*\p{N}+\s*[.)]?\s+(?=\S)/u, "");
  return stripped.length > 0 ? stripped : text;
}

function titleTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length >= 2 || /\p{N}/u.test(t));
}

function compact(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Recall over the printed title: OCR adds junk to a heading far more often than it drops words
export function titleSimilarity(entryTitle: string, headingText: string): number {
  const title = stripNumbering(entryTitle);
  const heading = stripNumbering(headingText);
  const t = [...new Set(titleTokens(title))];
  const h = new Set(titleTokens(heading));
  if (t.length === 0) return 0;
  const overlap = t.filter((w) => h.has(w)).length;
  if (t.length === 1) return overlap === 1 && h.size <= 3 ? 1 : 0;
  const sim = overlap / t.length;
  const tokenSim = h.size > 2 * t.length + 3 ? sim * 0.6 : sim;
  // OCR splits words ("ETHI CS OF INARTICULACY"): the letters still read as the title once spacing is ignored
  const ct = compact(title);
  const ch = compact(heading);
  if (ct.length >= MIN_COMPACT_LENGTH && ch.includes(ct) && ch.length <= ct.length * 1.5 + 3) return 1;
  return tokenSim;
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

// Every strong title match is a candidate anchor: a chapter heading repeated in the notes or an
// index matches just as well as the real one, and only the page-offset chain can tell them apart
export function findAnchors(entries: TocEntry[], catalog: HeadingCatalogEntry[]): PageAnchor[] {
  const anchors: PageAnchor[] = [];
  entries.forEach((entry, index) => {
    if (entry.page === null || titleTokens(entry.title).length < 2) return;
    const printed = entry.page;
    ranked([entry.title], catalog)
      .filter((c) => c.sim >= ANCHOR_SIMILARITY)
      .slice(0, MAX_ANCHORS_PER_ENTRY)
      .forEach((c) => anchors.push({ entry: index, printed, pdf: c.heading.page }));
  });
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
      if (a.entry === b.entry || b.pdf < a.pdf || Math.abs(b.pdf - b.printed - (a.pdf - a.printed)) > MAX_OFFSET_DRIFT) return;
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

// An entry without a printed page still starts before the next entry that has one
function ceilings(entries: ChapterEntry[], pageMap: PageMap | null): (number | null)[] {
  const out: (number | null)[] = entries.map(() => null);
  if (!pageMap) return out;
  let next: number | null = null;
  for (let k = entries.length - 1; k >= 0; k--) {
    out[k] = next;
    const page = entries[k]?.page;
    if (page !== null && page !== undefined) next = pageMap.expected(page);
  }
  return out;
}

export function locateEntries(entries: ChapterEntry[], catalog: HeadingCatalogEntry[], pageMap: PageMap | null): { located: Located[]; unresolved: Unresolved[] } {
  const located: Located[] = [];
  const unresolved: Unresolved[] = [];
  const ceiling = ceilings(entries, pageMap);
  let lastBlock = -1;

  for (const [k, entry] of entries.entries()) {
    const printedPage = entry.page;
    const expected = printedPage !== null && pageMap ? { page: pageMap.expected(printedPage), anchored: pageMap.anchored(printedPage) } : null;
    const limit = ceiling[k] ?? null;
    const pool = expected ? windowAround(catalog, expected.page, expected.anchored) : limit === null ? catalog : catalog.filter((h) => h.page <= limit);
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
