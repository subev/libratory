export type BookFilterInput = {
  kind: string;
  hasText: boolean;
  failed: boolean;
  chapterCount: number;
  chaptersWithAudio: number;
  activity: {
    extracting: boolean;
    assembling: boolean;
    aiNote: boolean;
    digest: boolean;
    synthesizing: number;
    translating: number;
    cleaning: number;
  };
  failures: { files: number; chapters: number; translations: number; cleanup: number };
};

export type BookFilterState = { working: boolean; attention: boolean; ready: boolean };

// Derived here rather than in the library page, because a folder row has to answer the same
// question about books the client never receives — the ones in its subtree.
export function bookFilterState(book: BookFilterInput): BookFilterState {
  const a = book.activity;
  const f = book.failures;
  const working =
    a.extracting || a.assembling || a.aiNote || a.digest ||
    a.synthesizing > 0 || a.translating > 0 || a.cleaning > 0;
  // A PDF that produced no text is stuck, not idle. Cancellations never reach here: `failed` and
  // the failure counts both exclude them, so nothing a user deliberately stopped is nagged about.
  const noText = !book.hasText && book.kind === "pdf" && !a.extracting;
  return {
    working,
    attention: book.failed || noText || f.files + f.chapters + f.translations + f.cleanup > 0,
    ready: !working && book.chapterCount > 0 && book.chaptersWithAudio === book.chapterCount,
  };
}
