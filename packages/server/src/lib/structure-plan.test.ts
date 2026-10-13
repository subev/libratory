import { describe, expect, it } from "vitest";

import { locateSavedChapter, locateSavedChapters } from "./chapter-anchors.ts";
import { planStructure, type ExistingChapter, type SlicedChapter } from "./structure-plan.ts";

const blocks = [
  { type: "Text", text: "front", page: 1, included: true },
  { type: "SectionHeader", text: "One", page: 2, included: true },
  { type: "Text", text: "one body", page: 2, included: true },
  { type: "SectionHeader", text: "Two", page: 3, included: true },
  { type: "Text", text: "two body", page: 3, included: true },
];

function sliced(title: string, start: number, end: number, fileIndex: number | null = null): SlicedChapter {
  const slice = blocks.slice(start, end);
  return {
    title,
    text: slice.map((b) => b.text).join("\n\n"),
    pageStart: slice[0]?.page ?? null,
    pageEnd: slice.at(-1)?.page ?? null,
    sourceBlocks: slice,
    fileIndex,
    range: { start, end },
  };
}

function existing(id: string, index: number, start: number, end: number, extra: Partial<ExistingChapter> = {}): ExistingChapter {
  const s = sliced(`saved ${id}`, start, end);
  return { id, index, title: s.title, customText: null, audioPath: null, pageStart: s.pageStart, sourceBlocks: s.sourceBlocks, sourceFileIndex: null, source: null, ...extra };
}

const locate = (c: ExistingChapter) => locateSavedChapter(blocks, c.sourceBlocks as typeof blocks);

describe("planStructure", () => {
  it("keeps a chapter cut from the same blocks and only renames it", () => {
    const saved = [existing("a", 0, 1, 3, { audioPath: "/a.m4a" }), existing("b", 1, 3, 5)];
    const plan = planStructure(saved, [sliced("One, renamed", 1, 3), sliced("Two", 3, 4), sliced("Tail", 4, 5)], {}, locate);

    expect(plan.order.map((p) => (p.kind === "kept" ? `kept:${p.chapter.id}:${p.title}` : `new:${p.chapter.title}`))).toEqual([
      "kept:a:One, renamed",
      "new:Two",
      "new:Tail",
    ]);
    expect(plan.removed.map((c) => c.id)).toEqual(["b"]);
    expect(plan.unchanged).toBe(false);
    expect(plan.renamedOnly).toBe(false);
  });

  it("keeps a chapter whose stored text differs from the extraction only in whitespace", () => {
    const stored = blocks.slice(1, 3).map((b) => ({ ...b, text: `${b.text}  ` }));
    const plan = planStructure([existing("a", 0, 1, 3, { sourceBlocks: stored, audioPath: "/a.m4a" })], [sliced("One", 1, 3), sliced("Two", 3, 5)], {}, locate);
    expect(plan.order.map((p) => p.kind)).toEqual(["kept", "new"]);
    expect(plan.removed).toEqual([]);
  });

  it("re-cuts a chapter whose blocks are the same words with one newly left out", () => {
    const stored = blocks.slice(1, 3).map((b, i) => ({ ...b, included: i === 0 }));
    const plan = planStructure([existing("a", 0, 1, 3, { sourceBlocks: stored, audioPath: "/a.m4a" })], [sliced("One", 1, 3), sliced("Two", 3, 5)], {}, locate);
    expect(plan.order.map((p) => p.kind)).toEqual(["new", "new"]);
    expect(plan.removed.map((c) => c.id)).toEqual(["a"]);
    expect(plan.unchanged).toBe(false);
  });

  it("keeps both of two chapters cut from a repeated passage", () => {
    const refrain = [
      { type: "Text", text: "A refrain", page: 1, included: true },
      { type: "Text", text: "Repeat me", page: 1, included: true },
    ];
    const twice = [...refrain, ...refrain];
    const saved: ExistingChapter[] = [
      { ...existing("a", 0, 0, 0), sourceBlocks: refrain, audioPath: "/a.m4a" },
      { ...existing("b", 1, 0, 0), sourceBlocks: refrain, audioPath: "/b.m4a" },
    ];
    const ranges = locateSavedChapters(twice, saved.map(() => refrain));
    const cut = (title: string, start: number, end: number): SlicedChapter => ({ ...sliced(title, 0, 0), sourceBlocks: twice.slice(start, end), range: { start, end } });
    const plan = planStructure(saved, [cut("saved a", 0, 2), cut("saved b", 2, 4)], {}, (c) => ranges[saved.indexOf(c)] ?? null);
    expect(plan.order.map((p) => (p.kind === "kept" ? p.chapter.id : "new"))).toEqual(["a", "b"]);
    expect(plan.unchanged).toBe(true);
  });

  it("tells a rename from a re-cut", () => {
    const saved = [existing("a", 0, 1, 3), existing("b", 1, 3, 5)];
    const plan = planStructure(saved, [sliced("One", 1, 3), sliced("saved b", 3, 5)], {}, locate);
    expect(plan.renamedOnly).toBe(true);
    expect(plan.unchanged).toBe(false);
  });

  it("reports an unchanged structure when every chapter is kept under its own title", () => {
    const saved = [existing("a", 0, 1, 3), existing("b", 1, 3, 5)];
    const plan = planStructure(saved, [sliced("saved a", 1, 3), sliced("saved b", 3, 5)], {}, locate);
    expect(plan.unchanged).toBe(true);
    expect(plan.removed).toEqual([]);
  });

  it("keeps inserted chapters at their index, so an untouched structure is unchanged", () => {
    const inserted = existing("note", 1, 0, 0, { sourceBlocks: null, source: { kind: "note", noteId: "n" } });
    const plan = planStructure([existing("a", 0, 1, 5), inserted], [sliced("One", 1, 3), sliced("Two", 3, 5)], {}, locate);
    expect(plan.order.map((p) => (p.kind === "kept" ? p.chapter.id : p.chapter.title))).toEqual(["One", "note", "Two"]);
    expect(plan.removed.map((c) => c.id)).toEqual(["a"]);

    const untouched = planStructure([existing("a", 0, 1, 5), inserted], [sliced("saved a", 1, 5)], {}, locate);
    expect(untouched.order.map((p) => p.kind === "kept" && p.chapter.id)).toEqual(["a", "note"]);
    expect(untouched.unchanged).toBe(true);
  });

  it("refuses to drop or overwrite a kept edit silently", () => {
    const a = existing("a", 0, 1, 3, { customText: "edit a" });
    const b = existing("b", 1, 3, 5, { customText: "edit b" });
    // Both merged into one chapter and both kept: only one text can land there
    const merged = planStructure([a, b], [sliced("All", 1, 5)], { a: "keep", b: "keep" }, locate);
    expect(merged.order.map((p) => (p.kind === "new" ? p.customText : "kept"))).toEqual(["edit a"]);
    expect(merged.collidingEdits.map((c) => c.id)).toEqual(["b"]);

    // The edited chapter is excluded altogether: a keep has nowhere to go
    const excluded = planStructure([a, b], [sliced("Two", 3, 5)], { a: "keep" }, locate);
    expect(excluded.orphanedEdits.map((c) => c.id)).toEqual(["a"]);
    expect(excluded.order.map((p) => p.kind === "kept" && p.chapter.id)).toEqual(["b"]);
  });

  it("needs a decision for an edited chapter a cut breaks", () => {
    const edited = existing("a", 0, 1, 5, { customText: "edited" });
    const undecided = planStructure([edited], [sliced("One", 1, 3), sliced("Two", 3, 5)], {}, locate);
    expect(undecided.undecided.map((c) => c.id)).toEqual(["a"]);

    const kept = planStructure([edited], [sliced("One", 1, 3), sliced("Two", 3, 5)], { a: "keep" }, locate);
    expect(kept.undecided).toEqual([]);
    expect(kept.order.map((p) => (p.kind === "new" ? p.customText : "kept"))).toEqual(["edited", null]);

    const dropped = planStructure([edited], [sliced("One", 1, 3), sliced("Two", 3, 5)], { a: "drop" }, locate);
    expect(dropped.order.map((p) => (p.kind === "new" ? p.customText : "kept"))).toEqual([null, null]);
  });

  it("falls back to the start page when the edited chapter cannot be located", () => {
    const edited = existing("a", 0, 3, 5, { customText: "edited", sourceBlocks: [{ type: "Text", text: "gone", page: 3, included: true }], pageStart: 3 });
    const plan = planStructure([edited], [sliced("One", 1, 3), sliced("Two", 3, 5)], { a: "keep" }, () => null);
    expect(plan.order.map((p) => (p.kind === "new" ? p.customText : "kept"))).toEqual([null, "edited"]);
    expect(plan.orphanedEdits).toEqual([]);

    const nowhere = planStructure([{ ...edited, pageStart: 99 }], [sliced("One", 1, 3)], { a: "keep" }, () => null);
    expect(nowhere.orphanedEdits.map((c) => c.id)).toEqual(["a"]);
  });
});
