// The crafting view imports this from the browser: keep it free of server-only imports.

export type AnchorBlock = { text: string; page: number; included?: boolean };

const TITLE_MAX_WORDS = 8;
const TITLE_MIN_LETTERS = 3;

// A short line in capitals that extraction read as a paragraph: the heading picker never saw it, so
// the crafting view offers it as a starting point. Letter classes only — no per-language word lists.
export function isTitleLike(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length > TITLE_MAX_WORDS) return false;
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (letters.length < TITLE_MIN_LETTERS) return false;
  return !/\p{Ll}/u.test(letters);
}

// A short capitals line that ends a page with other text above it is usually a closing mark
// ("THE END", a colophon) — but it can be a title whose story starts on the next page, so this is
// a demotion, never a dismissal: the crafting view keeps such a line reachable, only quieter.
export function closingMarks(blocks: { text: string; page: number; included: boolean; type: string }[]): boolean[] {
  const firstOnPage = new Map<number, number>();
  const lastOnPage = new Map<number, number>();
  blocks.forEach((b, i) => {
    if (!b.included) return;
    if (!firstOnPage.has(b.page)) firstOnPage.set(b.page, i);
    lastOnPage.set(b.page, i);
  });
  return blocks.map((b, i) => {
    if (!b.included || b.type === "SectionHeader" || !isTitleLike(b.text)) return false;
    return firstOnPage.get(b.page) !== i && lastOnPage.get(b.page) === i;
  });
}

// Where a saved chapter sits in the file's block list: the first run of blocks at or after `from`
// whose text, page and inclusion match its stored source blocks. Null when the extraction no longer
// holds that sequence. Whitespace is ignored: extraction's spacing has changed between releases, and
// a book cut before such a change must still find its chapters. Inclusion is not: the same words
// with a block newly left out or taken in are different spoken text, so that is a re-cut.
export function locateSavedChapter(blocks: AnchorBlock[], sourceBlocks: AnchorBlock[], from = 0): { start: number; end: number } | null {
  const first = sourceBlocks[0];
  if (!first) return null;
  const squeezed = squeezedTexts(blocks);
  const wanted = sourceBlocks.map((b) => squeeze(b.text));
  for (let i = from; i + sourceBlocks.length <= blocks.length; i++) {
    let matched = true;
    for (const [j, source] of sourceBlocks.entries()) {
      const block = blocks[i + j];
      if (!block || squeezed[i + j] !== wanted[j] || block.page !== source.page || !sameInclusion(block, source)) {
        matched = false;
        break;
      }
    }
    if (matched) return { start: i, end: i + sourceBlocks.length };
  }
  return null;
}

// Saved chapters in index order, each searched for after the one before it, so a passage that
// repeats (a refrain, a running title) resolves to its own occurrence rather than the first one.
// A chapter not found there is searched for from the top, which is how an old ordering still lands.
export function locateSavedChapters(blocks: AnchorBlock[], chapters: AnchorBlock[][]): ({ start: number; end: number } | null)[] {
  let cursor = 0;
  return chapters.map((sourceBlocks) => {
    const range = locateSavedChapter(blocks, sourceBlocks, cursor) ?? locateSavedChapter(blocks, sourceBlocks);
    if (range) cursor = range.end;
    return range;
  });
}

function sameInclusion(a: AnchorBlock, b: AnchorBlock): boolean {
  return a.included === undefined || b.included === undefined || a.included === b.included;
}

function squeeze(text: string): string {
  return text.replace(/\s+/gu, "");
}

// One pass over a file's blocks serves every saved chapter located in it
const squeezedByBlocks = new WeakMap<AnchorBlock[], string[]>();
function squeezedTexts(blocks: AnchorBlock[]): string[] {
  let texts = squeezedByBlocks.get(blocks);
  if (!texts) {
    texts = blocks.map((b) => squeeze(b.text));
    squeezedByBlocks.set(blocks, texts);
  }
  return texts;
}

// A block's bounding box in ten-thousandths of its page — the reader's cue-rect space, so the
// crafting view draws cuts where the reader draws highlights — or null when the layout left no
// polygon or the page's size is unknown.
export function blockBox(polygon: number[][] | undefined, page: { w: number; h: number } | undefined): [number, number, number, number] | null {
  const xs = polygon?.map((pt) => pt[0]).filter((v): v is number => v !== undefined) ?? [];
  const ys = polygon?.map((pt) => pt[1]).filter((v): v is number => v !== undefined) ?? [];
  if (!page || xs.length === 0 || ys.length === 0) return null;
  const to = (value: number, size: number) => Math.max(0, Math.min(10_000, Math.round((value / (size || 1)) * 10_000)));
  const x = to(Math.min(...xs), page.w);
  const y = to(Math.min(...ys), page.h);
  return [x, y, to(Math.max(...xs), page.w) - x, to(Math.max(...ys), page.h) - y];
}
