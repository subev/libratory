// The chapter-crafting draft: a set of chapter starts over the saved extraction, and what applying
// it would do to the chapters already there. Pure, so the outline, coverage and statuses can be
// asserted without a DOM.

export type CraftBlock = {
  i: number;
  page: number;
  type: string;
  text: string;
  included: boolean;
  level: number | null;
  heading: boolean;
  titleLike: boolean;
  /** A title-like line that ends its page under other text: probably "THE END", possibly a title. */
  closingMark: boolean;
  /** [x, y, w, h] in ten-thousandths of the page, the reader's cue-rect space; null without layout. */
  box: [number, number, number, number] | null;
};

export type SavedChapter = {
  id: string;
  index: number;
  title: string;
  hasAudio: boolean;
  durationMs: number | null;
  hasCustomText: boolean;
  variants: number;
  pageStart: number | null;
  pageEnd: number | null;
  range: { start: number; end: number } | null;
};

export type CraftFile = {
  fileIndex: number | null;
  filename: string;
  pdfUrl: string;
  missing: boolean;
  totalWords: number;
  totalPages: number;
  /** Page sizes in PDF points, from the layout sidecar; empty when it is missing. */
  pages: { p: number; w: number; h: number }[];
  blocks: CraftBlock[];
  saved: SavedChapter[];
};

export type BoundSource = "heading" | "manual" | "ai";
export type Bound = { title: string; source: BoundSource };
export type Resolution = "keep" | "drop";
export type Draft = { bounds: Record<string, Bound>; resolutions: Record<string, Resolution> };

export type ChapterStatus = "kept" | "new" | "reset" | "conflict";

// A saved chapter with an edited text override that no draft chapter keeps whole. "keep" puts the
// whole edit on `target`, the first new chapter over its text; with no target only "drop" is left.
export type EditDecision = {
  saved: SavedChapter;
  target: DraftChapter | null;
  resolution: Resolution | null;
  /** Another kept edit already lands on the same target: at most one can. */
  collision: boolean;
};

export type DraftChapter = {
  key: string;
  fileIndex: number | null;
  start: number;
  end: number;
  num: number;
  title: string;
  source: BoundSource;
  words: number;
  pageStart: number;
  pageEnd: number;
  status: ChapterStatus;
  /** The saved chapter cut from exactly these blocks, when there is one. */
  exact: SavedChapter | null;
  overlaps: SavedChapter[];
  /** Edits whose "keep" would land here. */
  decisions: EditDecision[];
};

export type FrontMatter = { fileIndex: number | null; words: number; pageStart: number; pageEnd: number; firstStart: number };

export type Outline = {
  chapters: DraftChapter[];
  front: FrontMatter[];
  totalWords: number;
  inChapters: number;
  excludedWords: number;
  /** Saved chapters the extraction no longer holds block for block; applying replaces them. */
  unlocated: SavedChapter[];
  /** Every edit a cut breaks, decided or not; the ones without a target can only be dropped. */
  decisions: EditDecision[];
  unchanged: boolean;
  counts: { kept: number; keptAudio: number; reset: number; fresh: number; conflicts: number };
};

export function boundKey(fileIndex: number | null, blockIndex: number): string {
  return `${fileIndex ?? "legacy"}:${blockIndex}`;
}

export function parseBoundKey(key: string): { fileIndex: number | null; blockIndex: number } {
  const [file, block] = key.split(":");
  return { fileIndex: file === "legacy" ? null : Number(file), blockIndex: Number(block) };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Words before each block, counting included blocks only; one entry past the end holds the total.
export function wordOffsets(blocks: CraftBlock[]): number[] {
  const before = [0];
  let total = 0;
  for (const b of blocks) {
    if (b.included) total += countWords(b.text);
    before.push(total);
  }
  return before;
}

// The saved chapters as a draft: each one that can still be found starts a chapter where it starts.
export function initialDraft(files: CraftFile[]): Draft {
  const bounds: Record<string, Bound> = {};
  for (const file of files) {
    for (const saved of file.saved) {
      if (!saved.range) continue;
      const block = file.blocks[saved.range.start];
      bounds[boundKey(file.fileIndex, saved.range.start)] = { title: saved.title, source: block?.heading ? "heading" : "manual" };
    }
  }
  return { bounds, resolutions: {} };
}

export function fileBounds(draft: Draft, fileIndex: number | null): { blockIndex: number; key: string; bound: Bound }[] {
  return Object.entries(draft.bounds)
    .map(([key, bound]) => ({ key, bound, ...parseBoundKey(key) }))
    .filter((b) => b.fileIndex === fileIndex)
    .sort((a, b) => a.blockIndex - b.blockIndex);
}

export function outline(files: CraftFile[], draft: Draft): Outline {
  const chapters: DraftChapter[] = [];
  const front: FrontMatter[] = [];
  const unlocated: SavedChapter[] = [];
  const decisions: EditDecision[] = [];
  let totalWords = 0;
  let excludedWords = 0;

  for (const file of files) {
    const before = wordOffsets(file.blocks);
    totalWords += before[file.blocks.length] ?? 0;
    unlocated.push(...file.saved.filter((s) => !s.range));
    const starts = fileBounds(draft, file.fileIndex);
    const firstStart = starts[0]?.blockIndex ?? file.blocks.length;
    const frontWords = before[firstStart] ?? 0;
    if (frontWords > 0) {
      excludedWords += frontWords;
      front.push({
        fileIndex: file.fileIndex,
        words: frontWords,
        pageStart: file.blocks[0]?.page ?? 0,
        pageEnd: file.blocks[firstStart - 1]?.page ?? 0,
        firstStart,
      });
    }

    const fileChapters: DraftChapter[] = [];
    for (const [i, s] of starts.entries()) {
      const start = s.blockIndex;
      const end = starts[i + 1]?.blockIndex ?? file.blocks.length;
      const exact = file.saved.find((c) => c.range && c.range.start === start && c.range.end === end) ?? null;
      const overlaps = file.saved.filter((c) => c.range && c.range.start < end && c.range.end > start);
      fileChapters.push({
        key: s.key,
        fileIndex: file.fileIndex,
        start,
        end,
        num: 0,
        title: s.bound.title,
        source: s.bound.source,
        words: (before[end] ?? 0) - (before[start] ?? 0),
        pageStart: file.blocks[start]?.page ?? 0,
        pageEnd: file.blocks[end - 1]?.page ?? 0,
        status: exact ? "kept" : overlaps.some((c) => c.hasAudio || c.variants > 0 || c.hasCustomText) ? "reset" : "new",
        exact,
        overlaps,
        decisions: [],
      });
    }

    // Mirrors the server's plan: an edited saved chapter nobody keeps whole lands on the first new
    // chapter over its text, by blocks when it can be located and by its first page otherwise
    const kept = new Set(fileChapters.flatMap((c) => (c.exact ? [c.exact.id] : [])));
    for (const saved of file.saved) {
      if (!saved.hasCustomText || kept.has(saved.id)) continue;
      const target =
        fileChapters.find((c) => {
          if (c.status === "kept") return false;
          if (saved.range) return c.start < saved.range.end && c.end > saved.range.start;
          return saved.pageStart != null && c.pageStart <= saved.pageStart && saved.pageStart <= c.pageEnd;
        }) ?? null;
      const resolution = draft.resolutions[saved.id] ?? null;
      const collision = resolution === "keep" && target !== null && target.decisions.some((d) => d.resolution === "keep");
      const decision: EditDecision = { saved, target, resolution, collision };
      decisions.push(decision);
      if (target) target.decisions.push(decision);
    }
    for (const c of fileChapters) {
      if (c.decisions.some((d) => !d.resolution || d.collision)) c.status = "conflict";
    }
    chapters.push(...fileChapters);
  }

  chapters.forEach((c, i) => {
    c.num = i + 1;
  });

  const savedCount = files.reduce((n, f) => n + f.saved.length, 0);
  const counts = {
    kept: chapters.filter((c) => c.status === "kept").length,
    keptAudio: chapters.filter((c) => c.status === "kept" && c.exact?.hasAudio).length,
    reset: chapters.filter((c) => c.status === "reset").length,
    fresh: chapters.filter((c) => c.status === "new").length,
    conflicts: decisions.filter((d) => !d.resolution || d.collision).length,
  };
  const unchanged =
    chapters.length === savedCount && chapters.every((c) => c.status === "kept" && c.exact?.title === c.title);

  return {
    chapters,
    front,
    totalWords,
    inChapters: chapters.reduce((n, c) => n + c.words, 0),
    excludedWords,
    unlocated,
    decisions,
    unchanged,
    counts,
  };
}

// What the apply mutation takes: every start with its title
export function draftBoundaries(draft: Draft): { fileIndex: number | null; blockIndex: number; title: string }[] {
  return Object.entries(draft.bounds).map(([key, bound]) => ({ ...parseBoundKey(key), title: bound.title.trim() || "Untitled chapter" }));
}

export type PageGroup =
  | { kind: "page"; page: number; blocks: CraftBlock[] }
  | { kind: "run"; from: number; to: number; words: number; pages: { page: number; blocks: CraftBlock[] }[] };

// How much of a folded run is open: pages revealed from its start and from its end, the way a diff
// unfolds context from either side of a hidden stretch
export type RunReveal = { head: number; tail: number };
export const RUN_STEP_PAGES = 2;

export function revealRun(reveal: RunReveal | undefined, how: "next" | "previous" | "all" | "none"): RunReveal | undefined {
  const current = reveal ?? { head: 0, tail: 0 };
  switch (how) {
    case "next":
      return { ...current, head: current.head + RUN_STEP_PAGES };
    case "previous":
      return { ...current, tail: current.tail + RUN_STEP_PAGES };
    case "all":
      return { head: Infinity, tail: 0 };
    case "none":
      return undefined;
  }
}

export function runSlices<T>(pages: T[], reveal: RunReveal | undefined): { head: T[]; hidden: T[]; tail: T[] } {
  const head = Math.min(reveal?.head ?? 0, pages.length);
  const tail = Math.min(reveal?.tail ?? 0, pages.length - head);
  return { head: pages.slice(0, head), hidden: pages.slice(head, pages.length - tail), tail: pages.slice(pages.length - tail) };
}

// Pages with nothing to offer — no heading, no title-like line, no suggestion, no chapter start —
// fold into a run, so a 600-page book shows its few decision points rather than every paragraph.
export function pageGroups(file: CraftFile, draft: Draft, suggested: Set<string>): PageGroup[] {
  const pages: { page: number; blocks: CraftBlock[]; plain: boolean }[] = [];
  for (const b of file.blocks) {
    const key = boundKey(file.fileIndex, b.i);
    // A closing mark is offered quietly and does not keep its page out of a run
    const marked = b.heading || (b.titleLike && !b.closingMark) || key in draft.bounds || suggested.has(key);
    const last = pages.at(-1);
    if (last && last.page === b.page) {
      last.blocks.push(b);
      if (marked) last.plain = false;
    } else {
      pages.push({ page: b.page, blocks: [b], plain: !marked });
    }
  }

  const groups: PageGroup[] = [];
  let run: typeof pages = [];
  const flush = () => {
    const first = run[0];
    const last = run.at(-1);
    if (!first || !last) return;
    if (run.length === 1) {
      groups.push({ kind: "page", page: first.page, blocks: first.blocks });
    } else {
      const words = run.reduce((n, p) => n + p.blocks.reduce((m, b) => m + (b.included ? countWords(b.text) : 0), 0), 0);
      groups.push({ kind: "run", from: first.page, to: last.page, words, pages: run.map(({ page, blocks }) => ({ page, blocks })) });
    }
    run = [];
  };
  for (const page of pages) {
    if (page.plain) {
      run.push(page);
      continue;
    }
    flush();
    groups.push({ kind: "page", page: page.page, blocks: page.blocks });
  }
  flush();
  return groups;
}
