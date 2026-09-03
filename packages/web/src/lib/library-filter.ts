import type { BookRow } from "./book-sort.ts";

export type LibraryFilter = "all" | "working" | "attention" | "done";

// Mirrors the server's own isActive in routes/books.ts — the chip and the row's pills must never
// disagree about whether something is happening.
export function isWorking(book: BookRow): boolean {
  const a = book.activity;
  return a.extracting || a.assembling || a.aiNote || a.digest ||
    a.synthesizing > 0 || a.translating > 0 || a.cleaning > 0;
}

// A PDF that produced no text is stuck, not idle, and the row already says so with no-text-pill.
// Nothing here is user-cancelled: books.list only counts hard failures, so unlike the chapters tab
// there is no deliberate stop to keep out of this.
export function needsAttention(book: BookRow): boolean {
  const f = book.failures;
  const noText = !book.hasText && book.kind === "pdf" && !book.activity.extracting;
  return book.failed || noText || f.files + f.chapters + f.translations + f.cleanup > 0;
}

export function isReady(book: BookRow): boolean {
  return !isWorking(book) && book.chapterCount > 0 && book.chaptersWithAudio === book.chapterCount;
}

export function matchesFilter(book: BookRow, filter: LibraryFilter): boolean {
  if (filter === "working") return isWorking(book);
  if (filter === "attention") return needsAttention(book);
  if (filter === "done") return isReady(book);
  return true;
}

// One pass for all four: books.list is the app's most expensive query and the tray polls it.
export function filterCounts(books: BookRow[]): Record<LibraryFilter, number> {
  const counts: Record<LibraryFilter, number> = { all: books.length, working: 0, attention: 0, done: 0 };
  for (const book of books) {
    if (isWorking(book)) counts.working++;
    if (needsAttention(book)) counts.attention++;
    if (isReady(book)) counts.done++;
  }
  return counts;
}
