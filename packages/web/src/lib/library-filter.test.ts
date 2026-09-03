import { describe, expect, it } from "vitest";
import { filterCounts, folderMatchesFilter, matchesFilter, type LibraryFilter } from "./library-filter.ts";
import type { BookRow, FolderRow } from "./book-sort.ts";

const FILTERS: LibraryFilter[] = ["all", "working", "attention", "done"];

const book = (working = false, attention = false, ready = false) =>
  ({ filterState: { working, attention, ready } }) as BookRow;
const folder = (working = 0, attention = 0, ready = 0) =>
  ({ filterCounts: { working, attention, ready } }) as FolderRow;

describe("matchesFilter", () => {
  it("reads the server's answer, and All takes everything", () => {
    expect(FILTERS.filter((f) => matchesFilter(book(true), f))).toEqual(["all", "working"]);
    expect(FILTERS.filter((f) => matchesFilter(book(false, false, true), f))).toEqual(["all", "done"]);
    expect(FILTERS.filter((f) => matchesFilter(book(), f))).toEqual(["all"]);
  });
});

describe("folderMatchesFilter", () => {
  it("keeps a folder only while its subtree still has a match", () => {
    expect(FILTERS.filter((f) => folderMatchesFilter(folder(2), f))).toEqual(["all", "working"]);
    expect(FILTERS.filter((f) => folderMatchesFilter(folder(), f))).toEqual(["all"]);
  });
});

describe("filterCounts", () => {
  it("counts each chip in one pass, and a book can land in more than one", () => {
    expect(filterCounts([book(true, true), book(false, false, true), book()])).toEqual({
      all: 3, working: 1, attention: 1, done: 1,
    });
  });

  it("agrees with matchesFilter", () => {
    const books = [book(true), book(false, true), book(false, false, true), book()];
    const counts = filterCounts(books);
    for (const f of FILTERS) expect(books.filter((b) => matchesFilter(b, f)).length).toBe(counts[f]);
  });
});
