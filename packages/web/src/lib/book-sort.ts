import type { RouterOutputs } from "../../../server/src/router.ts";

export type BookRow = RouterOutputs["books"]["list"]["books"][number];
export type FolderRow = RouterOutputs["books"]["list"]["folders"][number];

export type BookSortKey = "title" | "chapters" | "langs" | "outputs" | "size" | "lastActivity";
export type BookSortDir = "asc" | "desc";

export const BOOK_SORT_VALUE: Record<BookSortKey, (b: BookRow) => string | number> = {
  title: (b) => b.title.toLowerCase(),
  chapters: (b) => b.chapterCount,
  langs: (b) => b.languages.length,
  outputs: (b) => b.outputs.assemblies + b.outputs.pdfs + b.outputs.epubs + b.outputs.syncedEpubs,
  size: (b) => b.sizeBytes,
  lastActivity: (b) => new Date(b.lastActivityAt).getTime(),
};

// A key that has since been retired — "created" was one — falls back rather than throwing
export function loadBookSort(): { key: BookSortKey; dir: BookSortDir } {
  const stored = localStorage.getItem("bookList.sortKey");
  const key = stored && stored in BOOK_SORT_VALUE ? (stored as BookSortKey) : "lastActivity";
  const dir: BookSortDir = localStorage.getItem("bookList.sortDir") === "asc" ? "asc" : "desc";
  return { key, dir };
}

export function saveBookSort(key: BookSortKey, dir: BookSortDir) {
  localStorage.setItem("bookList.sortKey", key);
  localStorage.setItem("bookList.sortDir", dir);
}

// Folders stay grouped above books but follow the same active sort
const FOLDER_SORT_VALUE: Record<BookSortKey, (f: FolderRow) => string | number> = {
  title: (f) => f.name.toLowerCase(),
  chapters: (f) => f.bookCount,
  langs: () => 0,
  outputs: () => 0,
  size: (f) => f.sizeBytes,
  lastActivity: (f) => (f.lastActivityAt ? new Date(f.lastActivityAt).getTime() : 0),
};

function compare(va: string | number, vb: string | number, dir: BookSortDir): number {
  const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
  return dir === "asc" ? cmp : -cmp;
}

export function sortBooks(books: BookRow[], key: BookSortKey, dir: BookSortDir): BookRow[] {
  return [...books].sort((a, b) => compare(BOOK_SORT_VALUE[key](a), BOOK_SORT_VALUE[key](b), dir));
}

export function sortFolders(folders: FolderRow[], key: BookSortKey, dir: BookSortDir): FolderRow[] {
  return [...folders].sort((a, b) => compare(FOLDER_SORT_VALUE[key](a), FOLDER_SORT_VALUE[key](b), dir));
}
