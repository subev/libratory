import { describe, expect, it } from "vitest";
import { draftFromScope, matchBooks } from "./SourcePicker.tsx";

const books = [
  { id: "1", title: "Anna Karenina", author: "Leo Tolstoy" },
  { id: "2", title: "1839 Oliver Twist Charles Dickens", author: null },
  { id: "3", title: "War and Peace", author: "Leo Tolstoy" },
];

describe("finding a book to search", () => {
  it("matches the author as well as the title", () => {
    expect(matchBooks(books, "tolst").map((book) => book.id)).toEqual(["1", "3"]);
  });

  it("takes words in any order, across title and author", () => {
    expect(matchBooks(books, "dickens twist").map((book) => book.id)).toEqual(["2"]);
    expect(matchBooks(books, "tolstoy peace").map((book) => book.id)).toEqual(["3"]);
  });

  it("returns everything for an empty field", () => {
    expect(matchBooks(books, "  ")).toHaveLength(3);
  });
});

describe("a new chat opened from a conversation", () => {
  const book = (id: string, available = true) => ({ id, title: id, available });

  it("starts on the same books, minus any that are gone", () => {
    expect(draftFromScope({ kind: "books", books: [book("a"), book("b", false), book("c")] })).toEqual({ kind: "books", bookIds: ["a", "c"] });
  });

  it("keeps a folder or the whole library as they were", () => {
    expect(draftFromScope({ kind: "folder", folderId: "f", name: "Russian", available: true })).toEqual({ kind: "folder", folderId: "f" });
    expect(draftFromScope({ kind: "library" })).toEqual({ kind: "library" });
  });

  it("falls back to the library when nothing it searched is left", () => {
    expect(draftFromScope({ kind: "books", books: [book("a", false)] })).toEqual({ kind: "library" });
    expect(draftFromScope({ kind: "folder", folderId: "f", name: "Gone", available: false })).toEqual({ kind: "library" });
  });
});
