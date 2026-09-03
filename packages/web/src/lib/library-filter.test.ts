import { describe, expect, it } from "vitest";
import { filterCounts, isReady, isWorking, matchesFilter, needsAttention } from "./library-filter.ts";
import type { BookRow } from "./book-sort.ts";

const quiet = { extracting: false, assembling: false, aiNote: false, digest: false, synthesizing: 0, translating: 0, cleaning: 0 };
const clean = { files: 0, chapters: 0, translations: 0, cleanup: 0 };

function book(over: Partial<BookRow> = {}): BookRow {
  return {
    kind: "pdf", hasText: true, failed: false, chapterCount: 10, chaptersWithAudio: 10,
    activity: quiet, failures: clean, ...over,
  } as BookRow;
}

describe("isWorking", () => {
  it("counts every kind of job the row can be showing", () => {
    expect(isWorking(book())).toBe(false);
    for (const flag of ["extracting", "assembling", "aiNote", "digest"] as const) {
      expect(isWorking(book({ activity: { ...quiet, [flag]: true } }))).toBe(true);
    }
    for (const n of ["synthesizing", "translating", "cleaning"] as const) {
      expect(isWorking(book({ activity: { ...quiet, [n]: 1 } }))).toBe(true);
    }
  });
});

describe("needsAttention", () => {
  it("takes a failed book, and a failure of any of the four kinds", () => {
    expect(needsAttention(book({ failed: true }))).toBe(true);
    expect(needsAttention(book({ failures: { ...clean, translations: 1 } }))).toBe(true);
    expect(needsAttention(book())).toBe(false);
  });

  // A PDF that produced no text has nothing downstream and is not going to fix itself
  it("takes a PDF with no text, but not one still extracting", () => {
    expect(needsAttention(book({ hasText: false }))).toBe(true);
    expect(needsAttention(book({ hasText: false, activity: { ...quiet, extracting: true } }))).toBe(false);
  });

  it("leaves a synthetic book with no text alone — it has no PDF to have failed", () => {
    expect(needsAttention(book({ hasText: false, kind: "api" }))).toBe(false);
  });
});

describe("isReady", () => {
  it("wants every chapter narrated and nothing in flight", () => {
    expect(isReady(book())).toBe(true);
    expect(isReady(book({ chaptersWithAudio: 9 }))).toBe(false);
    expect(isReady(book({ chapterCount: 0, chaptersWithAudio: 0 }))).toBe(false);
    expect(isReady(book({ activity: { ...quiet, synthesizing: 1 } }))).toBe(false);
  });
});

describe("filterCounts", () => {
  it("counts each chip in one pass, and a book can land in more than one", () => {
    const books = [
      book(),
      book({ activity: { ...quiet, synthesizing: 2 } }),
      book({ failed: true, chaptersWithAudio: 3 }),
      book({ hasText: false, chapterCount: 0, chaptersWithAudio: 0 }),
    ];
    expect(filterCounts(books)).toEqual({ all: 4, working: 1, attention: 2, done: 1 });
  });

  it("agrees with matchesFilter", () => {
    const books = [book(), book({ failed: true }), book({ activity: { ...quiet, cleaning: 1 } })];
    const counts = filterCounts(books);
    for (const f of ["all", "working", "attention", "done"] as const) {
      expect(books.filter((b) => matchesFilter(b, f)).length).toBe(counts[f]);
    }
  });
});
