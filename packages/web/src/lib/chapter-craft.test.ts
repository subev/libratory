import { describe, expect, it } from "vitest";

import { boundKey, draftBoundaries, initialDraft, outline, pageGroups, revealRun, runSlices, type CraftBlock, type CraftFile, type SavedChapter } from "./chapter-craft.ts";

function block(i: number, page: number, text: string, extra: Partial<CraftBlock> = {}): CraftBlock {
  return { i, page, type: "Text", text, included: true, level: null, heading: false, titleLike: false, closingMark: false, box: null, ...extra };
}

// A four-tale collection whose extraction found two of the four headings
const blocks: CraftBlock[] = [
  block(0, 1, "THE TALES", { titleLike: true }),
  block(1, 1, "By the author"),
  block(2, 2, "THE TALE OF PETER RABBIT", { titleLike: true }),
  block(3, 2, "once upon a time there were"),
  block(4, 3, "four little rabbits and"),
  block(5, 4, "The Tale of Benjamin Bunny", { type: "SectionHeader", heading: true }),
  block(6, 4, "one morning a little rabbit"),
  block(7, 5, "sat on a bank"),
  block(8, 5, "THE TALE OF THE FLOPSY BUNNIES", { titleLike: true }),
  block(9, 5, "it is said that lettuce"),
  block(10, 6, "The Tale of Mr. Tod", { type: "SectionHeader", heading: true }),
  block(11, 6, "tommy brock was a badger"),
];

function saved(id: string, index: number, title: string, range: SavedChapter["range"], extra: Partial<SavedChapter> = {}): SavedChapter {
  return { id, index, title, hasAudio: false, durationMs: null, hasCustomText: false, variants: 0, pageStart: null, pageEnd: null, range, ...extra };
}

const file: CraftFile = {
  fileIndex: null,
  filename: "tales.pdf",
  pdfUrl: "/pdf/book/b",
  missing: false,
  pages: [],
  totalWords: 0,
  totalPages: 6,
  blocks,
  saved: [
    saved("pre", 0, "Preface", { start: 0, end: 5 }),
    saved("bb", 1, "The Tale of Benjamin Bunny", { start: 5, end: 10 }, { hasAudio: true, durationMs: 60_000, hasCustomText: true }),
    saved("tod", 2, "The Tale of Mr. Tod", { start: 10, end: 12 }, { hasAudio: true, durationMs: 30_000 }),
  ],
};

const K = (i: number) => boundKey(null, i);

describe("initialDraft", () => {
  it("starts a chapter at every saved chapter the extraction still holds", () => {
    const draft = initialDraft([file]);
    expect(Object.keys(draft.bounds)).toEqual([K(0), K(5), K(10)]);
    expect(draft.bounds[K(0)]).toEqual({ title: "Preface", source: "manual" });
    expect(draft.bounds[K(5)]).toEqual({ title: "The Tale of Benjamin Bunny", source: "heading" });
  });

  it("is unchanged until a start moves or a title changes", () => {
    const draft = initialDraft([file]);
    expect(outline([file], draft).unchanged).toBe(true);
    draft.bounds[K(5)] = { title: "Benjamin", source: "heading" };
    expect(outline([file], draft).unchanged).toBe(false);
  });
});

describe("outline", () => {
  it("excludes the text before the first start instead of inventing a preface", () => {
    const draft = initialDraft([file]);
    delete draft.bounds[K(0)];
    const o = outline([file], draft);
    expect(o.front).toEqual([{ fileIndex: null, words: 20, pageStart: 1, pageEnd: 3, firstStart: 5 }]);
    expect(o.excludedWords).toBe(20);
    expect(o.inChapters + o.excludedWords).toBe(o.totalWords);
    expect(o.chapters.map((c) => c.title)).toEqual(["The Tale of Benjamin Bunny", "The Tale of Mr. Tod"]);
  });

  it("tells kept, new and re-cut chapters apart, and needs a decision for a broken edit", () => {
    const draft = initialDraft([file]);
    delete draft.bounds[K(0)];
    draft.bounds[K(2)] = { title: "The Tale of Peter Rabbit", source: "manual" };
    draft.bounds[K(8)] = { title: "The Tale of the Flopsy Bunnies", source: "manual" };
    const o = outline([file], draft);

    expect(o.chapters.map((c) => [c.num, c.title, c.status, c.words, `p.${c.pageStart}-${c.pageEnd}`])).toEqual([
      [1, "The Tale of Peter Rabbit", "new", 15, "p.2-3"],
      [2, "The Tale of Benjamin Bunny", "conflict", 14, "p.4-5"],
      [3, "The Tale of the Flopsy Bunnies", "reset", 11, "p.5-5"],
      [4, "The Tale of Mr. Tod", "kept", 10, "p.6-6"],
    ]);
    expect(o.decisions.map((d) => [d.saved.id, d.target?.num ?? null, d.resolution])).toEqual([["bb", 2, null]]);
    expect(o.chapters[2]?.decisions).toEqual([]);
    expect(o.counts).toEqual({ kept: 1, keptAudio: 1, reset: 1, fresh: 1, conflicts: 1 });
    expect(o.front[0]?.words).toBe(5);

    draft.resolutions.bb = "keep";
    const decided = outline([file], draft);
    expect(decided.chapters[1]?.status).toBe("reset");
    expect(decided.chapters[1]?.decisions[0]?.resolution).toBe("keep");
    expect(decided.counts.conflicts).toBe(0);
  });

  it("offers a decision for every broken edit, even one with no chapter left", () => {
    const edited = { ...file, saved: file.saved.map((s) => ({ ...s, hasCustomText: true })) };
    // Everything merged into the last chapter: three edits, one target
    const draft = initialDraft([edited]);
    delete draft.bounds[K(0)];
    delete draft.bounds[K(5)];
    const o = outline([edited], draft);
    expect(o.chapters.map((c) => c.status)).toEqual(["kept"]);
    expect(o.decisions.map((d) => [d.saved.id, d.target?.num ?? null])).toEqual([["pre", null], ["bb", null]]);
    expect(o.counts.conflicts).toBe(2);

    // A keep needs a target; two keeps on one chapter collide
    draft.bounds[K(2)] = { title: "Peter", source: "manual" };
    draft.resolutions.pre = "keep";
    draft.resolutions.bb = "keep";
    const keeps = outline([edited], draft);
    expect(keeps.decisions.map((d) => [d.saved.id, d.target?.num ?? null, d.collision])).toEqual([["pre", 1, false], ["bb", 1, true]]);
    expect(keeps.chapters[0]?.status).toBe("conflict");
    expect(keeps.counts.conflicts).toBe(1);
  });

  it("lands an unlocated edit on the chapter covering its first page, as the server does", () => {
    const lost = { ...file, saved: [...file.saved, saved("gone", 3, "Gone", null, { hasCustomText: true, pageStart: 5, pageEnd: 5 })] };
    const o = outline([lost], initialDraft([lost]));
    expect(o.decisions.map((d) => [d.saved.id, d.target?.num ?? null])).toEqual([["gone", null]]);

    const draft = initialDraft([lost]);
    delete draft.bounds[K(5)];
    const recut = outline([lost], draft);
    expect(recut.decisions.map((d) => [d.saved.id, d.target?.num ?? null])).toEqual([["bb", 1], ["gone", 1]]);
  });

  it("lists saved chapters the extraction no longer holds", () => {
    const lost = { ...file, saved: [...file.saved, saved("gone", 3, "Gone", null)] };
    const o = outline([lost], initialDraft([lost]));
    expect(o.unlocated.map((c) => c.id)).toEqual(["gone"]);
    expect(o.unchanged).toBe(false);
  });
});

describe("draftBoundaries", () => {
  it("sends every start with a title, never an empty one", () => {
    const draft = initialDraft([file]);
    draft.bounds[K(5)] = { title: "  ", source: "heading" };
    expect(draftBoundaries(draft)).toEqual([
      { fileIndex: null, blockIndex: 0, title: "Preface" },
      { fileIndex: null, blockIndex: 5, title: "Untitled chapter" },
      { fileIndex: null, blockIndex: 10, title: "The Tale of Mr. Tod" },
    ]);
  });
});

describe("pageGroups", () => {
  it("folds consecutive pages with nothing to decide into a run", () => {
    const plain = [
      block(0, 1, "CHAPTER", { heading: true }),
      block(1, 2, "a b"),
      block(2, 3, "c d"),
      block(3, 4, "e"),
      block(4, 5, "f", { titleLike: true }),
      block(5, 6, "g"),
    ];
    const f: CraftFile = { ...file, blocks: plain, saved: [] };
    const groups = pageGroups(f, { bounds: {}, resolutions: {} }, new Set());
    expect(groups.map((g) => (g.kind === "run" ? `run ${g.from}-${g.to} ${g.words}w` : `page ${g.page}`))).toEqual([
      "page 1",
      "run 2-4 5w",
      "page 5",
      "page 6",
    ]);
  });

  it("lets a closing mark fold into a run", () => {
    const plain = [block(0, 1, "a"), block(1, 2, "b"), block(2, 2, "THE END", { titleLike: true, closingMark: true }), block(3, 3, "c")];
    const f: CraftFile = { ...file, blocks: plain, saved: [] };
    expect(pageGroups(f, { bounds: {}, resolutions: {} }, new Set()).map((g) => g.kind)).toEqual(["run"]);
  });

  it("opens a run around a chapter start or a suggestion", () => {
    const plain = [block(0, 1, "a"), block(1, 2, "b"), block(2, 3, "c"), block(3, 4, "d")];
    const f: CraftFile = { ...file, blocks: plain, saved: [] };
    const withStart = pageGroups(f, { bounds: { [K(2)]: { title: "x", source: "manual" } }, resolutions: {} }, new Set());
    expect(withStart.map((g) => g.kind)).toEqual(["run", "page", "page"]);
    const withSuggestion = pageGroups(f, { bounds: {}, resolutions: {} }, new Set([K(1)]));
    expect(withSuggestion.map((g) => g.kind)).toEqual(["page", "page", "run"]);
  });
});

describe("runSlices", () => {
  const pages = [1, 2, 3, 4, 5];

  it("unfolds a run from either end and meets in the middle", () => {
    expect(runSlices(pages, undefined)).toEqual({ head: [], hidden: [1, 2, 3, 4, 5], tail: [] });
    let reveal = revealRun(undefined, "next");
    expect(runSlices(pages, reveal)).toEqual({ head: [1, 2], hidden: [3, 4, 5], tail: [] });
    reveal = revealRun(reveal, "previous");
    expect(runSlices(pages, reveal)).toEqual({ head: [1, 2], hidden: [3], tail: [4, 5] });
    reveal = revealRun(reveal, "previous");
    expect(runSlices(pages, reveal)).toEqual({ head: [1, 2], hidden: [], tail: [3, 4, 5] });
  });

  it("opens and closes the whole run", () => {
    expect(runSlices(pages, revealRun(undefined, "all"))).toEqual({ head: [1, 2, 3, 4, 5], hidden: [], tail: [] });
    expect(revealRun({ head: 2, tail: 2 }, "none")).toBeUndefined();
  });
});
