import type { BookRow, FolderRow } from "./book-sort.ts";

export type LibraryFilter = "all" | "working" | "attention" | "done";

const KEY = { working: "working", attention: "attention", done: "ready" } as const;

export function matchesFilter(book: BookRow, filter: LibraryFilter): boolean {
  return filter === "all" || book.filterState[KEY[filter]];
}

// A folder is navigation, not a result: it stays only while something inside it still matches,
// counted over its whole subtree by the server.
export function folderMatchesFilter(folder: FolderRow, filter: LibraryFilter): boolean {
  return filter === "all" || folder.filterCounts[KEY[filter]] > 0;
}

// One pass for all four: books.list is the app's most expensive query and the tray polls it.
export function filterCounts(books: BookRow[]): Record<LibraryFilter, number> {
  const counts: Record<LibraryFilter, number> = { all: books.length, working: 0, attention: 0, done: 0 };
  for (const book of books) {
    if (book.filterState.working) counts.working++;
    if (book.filterState.attention) counts.attention++;
    if (book.filterState.ready) counts.done++;
  }
  return counts;
}
