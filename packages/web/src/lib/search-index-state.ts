// What a book's search index means for a search of it: the dot and the hint the assistant panel
// shows beside the book's name. Pure; it lived in the book header while the chat link did.
export type IndexState = { dot: string; hint: string; pulse: boolean };

export function indexState(searchIndex: { status?: string } | null | undefined, hasChapters: boolean): IndexState {
  const status = searchIndex?.status;
  if (status === "done") return { dot: "bg-(--success-text)", hint: "Fully indexed — keyword and semantic search", pulse: false };
  if (status === "queued" || status === "chunking" || status === "embedding") {
    return { dot: "bg-(--badge-extracting-text)", hint: "Search indexing is running", pulse: true };
  }
  if (status === "failed") return { dot: "bg-(--danger-text)", hint: "Search indexing failed — this book is not searchable", pulse: false };
  return {
    dot: "bg-(--text-faint)",
    hint: hasChapters ? "Not indexed yet" : "Not indexed yet — extract chapters first",
    pulse: false,
  };
}
