// Where the assistant can take the person: every target is a URL the web app already answers
// to, so navigating is the whole action. Dependency-free — the panel imports it to follow a call.
export const APP_TARGETS = [
  "library",
  "folder",
  "book",
  "source-files",
  "chapters",
  "outputs",
  "notes",
  "extract",
  "review-chapters",
  "synthesize",
  "export",
  "chapter",
  "reader",
] as const;

export type AppTarget = (typeof APP_TARGETS)[number];

export type ShowInApp = {
  target: AppTarget;
  bookId?: string;
  folderId?: string;
  chapterId?: string;
  chapterIndex?: number;
  atMs?: number;
};

// The dialogs the book page opens from its URL, consumed on arrival
export const BOOK_DIALOGS = ["extract", "structure", "synthesize", "export"] as const;
export type BookDialog = (typeof BOOK_DIALOGS)[number];

export function appUrlFor(show: ShowInApp): string {
  const book = show.bookId ? `/books/${show.bookId}` : null;
  const needBook = (): string => {
    if (!book) throw new Error(`${show.target} needs a bookId`);
    return book;
  };
  switch (show.target) {
    case "library":
      return "/";
    case "folder":
      if (!show.folderId) throw new Error("folder needs a folderId");
      return `/folders/${show.folderId}`;
    case "book":
      return needBook();
    case "source-files":
      return `${needBook()}?tab=files`;
    case "chapters":
      return `${needBook()}?tab=chapters`;
    case "outputs":
      return `${needBook()}?tab=outputs`;
    case "notes":
      return `${needBook()}?tab=notes`;
    case "extract":
      return `${needBook()}?dialog=extract`;
    case "review-chapters":
      return `${needBook()}?tab=chapters&dialog=structure`;
    case "synthesize":
      return `${needBook()}?tab=chapters&dialog=synthesize`;
    case "export":
      return `${needBook()}?tab=chapters&dialog=export`;
    case "chapter":
      if (!show.chapterId) throw new Error("chapter needs a chapterId");
      return `${needBook()}?tab=chapters&chapter=${show.chapterId}`;
    case "reader": {
      const params = new URLSearchParams();
      if (show.chapterIndex !== undefined) params.set("chapter", String(show.chapterIndex));
      if (show.atMs !== undefined) params.set("t", String(Math.max(0, Math.round(show.atMs))));
      const query = params.toString();
      return `${needBook()}/read${query ? `?${query}` : ""}`;
    }
    default: {
      const unhandled: never = show.target;
      throw new Error(`unhandled target ${unhandled}`);
    }
  }
}

// What the trace says once the person has been taken there
export function describeTarget(show: ShowInApp): string {
  switch (show.target) {
    case "library":
      return "Opened the library";
    case "folder":
      return "Opened the folder";
    case "book":
      return "Opened the book";
    case "source-files":
      return "Opened the source files";
    case "chapters":
      return "Opened the chapters";
    case "outputs":
      return "Opened the outputs";
    case "notes":
      return "Opened the notes";
    case "extract":
      return "Opened the extract dialog";
    case "review-chapters":
      return "Opened the chapter review";
    case "synthesize":
      return "Opened the narration dialog";
    case "export":
      return "Opened the export dialog";
    case "chapter":
      return "Opened the chapter";
    case "reader":
      return "Opened the reader";
    default: {
      const unhandled: never = show.target;
      throw new Error(`unhandled target ${unhandled}`);
    }
  }
}
