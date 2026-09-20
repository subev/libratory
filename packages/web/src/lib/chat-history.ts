import type { RouterOutputs } from "../../../server/src/router.ts";

export type ConversationSummary = RouterOutputs["chats"]["list"][number];
export type ConversationScope = NonNullable<RouterOutputs["chats"]["get"]>["scope"];
export type BookRef = { id: string; title: string; available: boolean };

// "scoped" finds chats that chose the book as a source. "cites" adds the wider chats — a folder, the
// whole library — that quoted a passage from it. A book merely being searchable never counts.
export type BookFilterMode = "scoped" | "cites";

export type HistoryFilter = { search: string; bookId: string; mode: BookFilterMode };

export const NO_FILTER: HistoryFilter = { search: "", bookId: "", mode: "scoped" };

export function filterActive(filter: HistoryFilter): boolean {
  return filter.bookId !== "" || filter.search.trim() !== "";
}

function scopedBooks(conversation: ConversationSummary): BookRef[] {
  return conversation.scope.kind === "books" ? conversation.scope.books : [];
}

export function filterConversations(conversations: ConversationSummary[], filter: HistoryFilter): ConversationSummary[] {
  const query = filter.search.trim().toLowerCase();
  return conversations.filter((conversation) => {
    if (filter.bookId) {
      const chose = scopedBooks(conversation).some((book) => book.id === filter.bookId);
      const quoted = filter.mode === "cites" && conversation.citedBooks.some((book) => book.id === filter.bookId);
      if (!chose && !quoted) return false;
    }
    // A title is the first question's excerpt unless renamed, so the two are searched as one
    return !query || [conversation.title, ...conversation.questions].some((text) => text.toLowerCase().includes(query));
  });
}

// Every book a conversation chose or quoted, so the filter can name a book that is gone
export function filterBookOptions(conversations: ConversationSummary[]): BookRef[] {
  const byId = new Map<string, BookRef>();
  for (const conversation of conversations) {
    for (const book of [...scopedBooks(conversation), ...conversation.citedBooks]) byId.set(book.id, book);
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export type HistoryGroup = { label: "Today" | "Yesterday" | "Earlier"; conversations: ConversationSummary[] };

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Input is newest first, and stays so inside each group
export function groupByDay(conversations: ConversationSummary[], now: Date): HistoryGroup[] {
  const today = startOfDay(now);
  const groups: HistoryGroup[] = [
    { label: "Today", conversations: [] },
    { label: "Yesterday", conversations: [] },
    { label: "Earlier", conversations: [] },
  ];
  for (const conversation of conversations) {
    const at = new Date(conversation.updatedAt).getTime();
    const group = at >= today ? groups[0] : at >= today - DAY_MS ? groups[1] : groups[2];
    group?.conversations.push(conversation);
  }
  return groups.filter((group) => group.conversations.length > 0);
}

export function formatWhen(date: string | Date, now: Date): string {
  const at = new Date(date);
  const today = startOfDay(now);
  if (at.getTime() >= today) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at.getTime() >= today - DAY_MS) return "Yesterday";
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

export type ScopeSummary = { kind: "library" | "folder" | "book" | "books" | "removed"; label: string };

// One line under a conversation's title: what it searched
export function scopeSummary(scope: ConversationSummary["scope"] | ConversationScope): ScopeSummary {
  switch (scope.kind) {
    case "library":
      return { kind: "library", label: "Whole library" };
    case "folder":
      return { kind: "folder", label: scope.name };
    case "books": {
      const [first, ...rest] = scope.books;
      if (!first) return { kind: "removed", label: "No books" };
      if (scope.books.every((book) => !book.available)) {
        return { kind: "removed", label: rest.length === 0 ? `${first.title} · removed` : `${scope.books.length} books · removed` };
      }
      if (rest.length === 0) return { kind: "book", label: first.title };
      return { kind: "books", label: `${scope.books.length} books · ${first.title}` };
    }
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}

// What is left to search. Nothing left means the conversation can be read but not continued —
// it is never widened to the whole library.
export function askable(scope: ConversationScope): { canAsk: boolean; remaining: number; removed: BookRef[] } {
  switch (scope.kind) {
    case "library":
      return { canAsk: true, remaining: 0, removed: [] };
    case "folder":
      return { canAsk: scope.available, remaining: 0, removed: [] };
    case "books": {
      const removed = scope.books.filter((book) => !book.available);
      const remaining = scope.books.length - removed.length;
      return { canAsk: remaining > 0, remaining, removed };
    }
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}
