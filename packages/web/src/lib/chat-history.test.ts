import { describe, expect, it } from "vitest";
import {
  askable,
  filterBookOptions,
  filterConversations,
  formatWhen,
  groupByDay,
  NO_FILTER,
  scopeSummary,
  type ConversationSummary,
} from "./chat-history.ts";

const book = (id: string, available = true) => ({ id, title: `Book ${id}`, available });

function conversation(id: string, over: Partial<ConversationSummary>): ConversationSummary {
  return { id, title: `Chat ${id}`, updatedAt: "2026-09-20T10:00:00", answers: 1, questions: [], scope: { kind: "library" }, citedBooks: [], ...over };
}

const NOW = new Date("2026-09-20T15:00:00");

describe("filtering history by book", () => {
  const chose = conversation("chose", { scope: { kind: "books", books: [book("a"), book("b")] } });
  const quoted = conversation("quoted", { citedBooks: [book("a")] });
  const merelySearchable = conversation("library", {});
  const all = [chose, quoted, merelySearchable];

  it("finds only chats that chose the book by default, multi-book ones included", () => {
    expect(filterConversations(all, { ...NO_FILTER, bookId: "a" }).map((c) => c.id)).toEqual(["chose"]);
  });

  it("adds wider chats that quoted it, and still not ones it was merely searchable in", () => {
    expect(filterConversations(all, { search: "", bookId: "a", mode: "cites" }).map((c) => c.id)).toEqual(["chose", "quoted"]);
  });

  it("combines the book with a title search", () => {
    expect(filterConversations(all, { search: "QUOTED", bookId: "a", mode: "cites" }).map((c) => c.id)).toEqual(["quoted"]);
    expect(filterConversations(all, { search: "dreams", bookId: "", mode: "scoped" })).toEqual([]);
  });

  it("searches every question asked, not only the one the title came from", () => {
    const later = conversation("later", { questions: ["How does it begin?", "Does the Gambler have anything like this?"] });
    expect(filterConversations([later, quoted], { ...NO_FILTER, search: "gambler" }).map((c) => c.id)).toEqual(["later"]);
  });

  it("offers every chosen or quoted book once, removed ones too", () => {
    const gone = conversation("gone", { scope: { kind: "books", books: [book("z", false)] } });
    expect(filterBookOptions([...all, gone]).map((b) => [b.id, b.available])).toEqual([["a", true], ["b", true], ["z", false]]);
  });
});

describe("grouping and dating", () => {
  it("groups by calendar day, not by 24 hours", () => {
    const groups = groupByDay([
      conversation("today", { updatedAt: "2026-09-20T00:05:00" }),
      conversation("late-yesterday", { updatedAt: "2026-09-19T23:55:00" }),
      conversation("old", { updatedAt: "2026-08-02T12:00:00" }),
    ], NOW);
    expect(groups.map((g) => [g.label, g.conversations.map((c) => c.id)])).toEqual([
      ["Today", ["today"]], ["Yesterday", ["late-yesterday"]], ["Earlier", ["old"]],
    ]);
  });

  it("leaves out empty groups", () => {
    expect(groupByDay([conversation("old", { updatedAt: "2026-08-02T12:00:00" })], NOW).map((g) => g.label)).toEqual(["Earlier"]);
  });

  it("says yesterday as a word and an older day as a date", () => {
    expect(formatWhen("2026-09-19T23:55:00", NOW)).toBe("Yesterday");
    expect(formatWhen("2026-08-02T12:00:00", NOW)).toMatch(/2/);
    expect(formatWhen("2025-08-02T12:00:00", NOW)).toMatch(/2025/);
  });
});

describe("what a conversation searched", () => {
  it("summarises each kind of scope", () => {
    expect(scopeSummary({ kind: "library" })).toEqual({ kind: "library", label: "Whole library" });
    expect(scopeSummary({ kind: "folder", folderId: "f", name: "Russian" })).toEqual({ kind: "folder", label: "Russian" });
    expect(scopeSummary({ kind: "books", books: [book("a")] })).toEqual({ kind: "book", label: "Book a" });
    expect(scopeSummary({ kind: "books", books: [book("a"), book("b"), book("c")] })).toEqual({ kind: "books", label: "3 books · Book a" });
    expect(scopeSummary({ kind: "books", books: [book("a", false)] })).toEqual({ kind: "removed", label: "Book a · removed" });
  });

  it("stays askable while one chosen book is left, and closes when none is", () => {
    expect(askable({ kind: "books", books: [book("a"), book("b", false)] })).toMatchObject({ canAsk: true, remaining: 1 });
    expect(askable({ kind: "books", books: [book("b", false)] })).toMatchObject({ canAsk: false, remaining: 0 });
    expect(askable({ kind: "folder", folderId: "f", name: "Gone", available: false }).canAsk).toBe(false);
    expect(askable({ kind: "library" }).canAsk).toBe(true);
  });
});
