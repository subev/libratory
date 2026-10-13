import type { SlicedChapter as Sliced } from "./marker.ts";

export type ExistingChapter = {
  id: string;
  index: number;
  title: string;
  customText: string | null;
  audioPath: string | null;
  pageStart: number | null;
  sourceBlocks: unknown;
  sourceFileIndex: number | null;
  source: unknown;
};

export type SlicedChapter = Sliced & { fileIndex: number | null };

export type EditResolution = "keep" | "drop";

export type PlannedChapter =
  | { kind: "kept"; chapter: ExistingChapter; title: string }
  | { kind: "new"; chapter: SlicedChapter; customText: string | null };

export type StructurePlan = {
  /** Every chapter the book will have, in index order. */
  order: PlannedChapter[];
  removed: ExistingChapter[];
  /** Edited chapters a cut breaks that have no resolution yet. */
  undecided: ExistingChapter[];
  /** Edits resolved "keep" that no new chapter covers: nothing to keep them on. */
  orphanedEdits: ExistingChapter[];
  /** Edits resolved "keep" whose new chapter already carries another kept edit. */
  collidingEdits: ExistingChapter[];
  /** Only titles differ: nothing is cut, moved or removed. */
  renamedOnly: boolean;
  unchanged: boolean;
};

// Decides what a new set of boundaries does to the chapters already there. A chapter cut from the
// same blocks as a saved one — the run `locate` finds for it — is kept: row, audio, edits, variants,
// and only renamed; the rest are replaced. An edited text override cannot be split by a cut, so a broken one needs a decision:
// keep it whole on the first new chapter covering the old one, or go back to the extracted text.
// A keep that has nowhere to go, or two keeps landing on one chapter, is reported rather than
// quietly dropped; the caller refuses before touching anything.
export function planStructure(
  existing: ExistingChapter[],
  sliced: SlicedChapter[],
  resolutions: Record<string, EditResolution>,
  locate: (chapter: ExistingChapter) => { start: number; end: number } | null,
): StructurePlan {
  const byIndex = [...existing].sort((a, b) => a.index - b.index);
  const extracted = byIndex.filter((c) => c.source == null);

  const located = new Map(extracted.map((c) => [c, locate(c)]));
  const unmatched = new Set(extracted);
  const order: PlannedChapter[] = [];
  const fresh: { planned: PlannedChapter & { kind: "new" }; fileIndex: number | null; range: { start: number; end: number } }[] = [];
  for (const chapter of sliced) {
    const match = [...unmatched].find((c) => {
      const range = located.get(c);
      return c.sourceFileIndex === chapter.fileIndex && range?.start === chapter.range.start && range.end === chapter.range.end;
    });
    if (match) {
      unmatched.delete(match);
      order.push({ kind: "kept", chapter: match, title: chapter.title });
    } else {
      const planned = { kind: "new" as const, chapter, customText: null };
      order.push(planned);
      fresh.push({ planned, fileIndex: chapter.fileIndex, range: chapter.range });
    }
  }
  // Inserted chapters (notes, urls) are not cut from any file; each stays at the index it had,
  // clamped to the end, so an unchanged structure keeps its order
  for (const chapter of byIndex.filter((c) => c.source != null)) {
    order.splice(Math.min(chapter.index, order.length), 0, { kind: "kept", chapter, title: chapter.title });
  }

  const removed = [...unmatched];
  const undecided: ExistingChapter[] = [];
  const orphanedEdits: ExistingChapter[] = [];
  const collidingEdits: ExistingChapter[] = [];
  for (const old of removed) {
    if (!old.customText) continue;
    const resolution = resolutions[old.id];
    if (!resolution) {
      undecided.push(old);
      continue;
    }
    if (resolution === "drop") continue;
    const range = located.get(old) ?? null;
    const target = fresh.find(({ planned, fileIndex, range: r }) => {
      if (fileIndex !== old.sourceFileIndex) return false;
      if (range) return r.start < range.end && r.end > range.start;
      // A chapter the extraction no longer holds block for block: fall back to the page it started on
      const { pageStart, pageEnd } = planned.chapter;
      return old.pageStart != null && pageStart != null && pageEnd != null && pageStart <= old.pageStart && old.pageStart <= pageEnd;
    });
    if (!target) orphanedEdits.push(old);
    else if (target.planned.customText !== null) collidingEdits.push(old);
    else target.planned.customText = old.customText;
  }

  const sameChapters = removed.length === 0 && fresh.length === 0;
  const sameOrder = sameChapters && order.every((p, i) => p.kind === "kept" && p.chapter.id === byIndex[i]?.id);
  const sameTitles = order.every((p) => p.kind === "kept" && p.title === p.chapter.title);

  return {
    order,
    removed,
    undecided,
    orphanedEdits,
    collidingEdits,
    renamedOnly: sameOrder && !sameTitles,
    unchanged: sameOrder && sameTitles,
  };
}
