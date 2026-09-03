import { describe, expect, it } from "vitest";
import { bookFilterState, type BookFilterInput } from "./book-filter.ts";

const quiet = { extracting: false, assembling: false, aiNote: false, digest: false, synthesizing: 0, translating: 0, cleaning: 0 };
const clean = { files: 0, chapters: 0, translations: 0, cleanup: 0 };

const book = (over: Partial<BookFilterInput> = {}): BookFilterInput => ({
  kind: "pdf", hasText: true, failed: false, chapterCount: 10, chaptersWithAudio: 10,
  activity: quiet, failures: clean, ...over,
});

describe("bookFilterState", () => {
  it("calls every kind of running job working", () => {
    expect(bookFilterState(book()).working).toBe(false);
    for (const flag of ["extracting", "assembling", "aiNote", "digest"] as const) {
      expect(bookFilterState(book({ activity: { ...quiet, [flag]: true } })).working).toBe(true);
    }
    for (const n of ["synthesizing", "translating", "cleaning"] as const) {
      expect(bookFilterState(book({ activity: { ...quiet, [n]: 1 } })).working).toBe(true);
    }
  });

  it("takes a failed book and a failure of any of the four kinds", () => {
    expect(bookFilterState(book({ failed: true })).attention).toBe(true);
    expect(bookFilterState(book({ failures: { ...clean, translations: 1 } })).attention).toBe(true);
    expect(bookFilterState(book()).attention).toBe(false);
  });

  // A PDF that produced no text has nothing downstream and will not fix itself
  it("takes a PDF with no text, but not one still extracting", () => {
    expect(bookFilterState(book({ hasText: false })).attention).toBe(true);
    expect(bookFilterState(book({ hasText: false, activity: { ...quiet, extracting: true } })).attention).toBe(false);
  });

  it("leaves a synthetic book with no text alone — it has no PDF to have failed", () => {
    expect(bookFilterState(book({ hasText: false, kind: "api" })).attention).toBe(false);
  });

  it("calls a book ready only when every chapter is narrated and nothing is in flight", () => {
    expect(bookFilterState(book()).ready).toBe(true);
    expect(bookFilterState(book({ chaptersWithAudio: 9 })).ready).toBe(false);
    expect(bookFilterState(book({ chapterCount: 0, chaptersWithAudio: 0 })).ready).toBe(false);
    expect(bookFilterState(book({ activity: { ...quiet, synthesizing: 1 } })).ready).toBe(false);
  });
});
