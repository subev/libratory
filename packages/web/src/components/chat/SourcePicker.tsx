import { useState } from "react";
import { Dropdown } from "../Dropdown.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { IconBook, IconSearch } from "../icons.tsx";
import type { ConversationScope, ConversationSummary } from "../../lib/chat-history.ts";

// What a chat that has not been asked anything yet is going to search
export type DraftScope =
  | { kind: "library" }
  | { kind: "folder"; folderId: string }
  | { kind: "books"; bookIds: string[] };

export type FolderOption = { id: string; name: string; depth: number };
export type BookOption = { id: string; title: string; author: string | null };

const KINDS = [
  { id: "library", label: "Whole library" },
  { id: "folder", label: "A folder" },
  { id: "books", label: "Specific books" },
] as const;

// What a new chat starts with when it is opened from a conversation: the same sources, as far as
// they still exist. Re-picking books for every chat is a chore; widening to the library is one click.
export function draftFromScope(scope: ConversationScope | ConversationSummary["scope"]): DraftScope {
  switch (scope.kind) {
    case "library":
      return { kind: "library" };
    case "folder":
      // The history list does not say whether a folder is still there; creating the chat will
      return !("available" in scope) || scope.available ? { kind: "folder", folderId: scope.folderId } : { kind: "library" };
    case "books": {
      const bookIds = scope.books.filter((book) => book.available).map((book) => book.id);
      return bookIds.length > 0 ? { kind: "books", bookIds } : { kind: "library" };
    }
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}

// Hundreds of books, so never a plain list: a handful of rows and a field that narrows them
const SHOWN_BOOKS = 8;

// Every word, in any order, across the title and the author
export function matchBooks(books: BookOption[], find: string): BookOption[] {
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return books;
  return books.filter((book) => {
    const haystack = `${book.title} ${book.author ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function draftReady(draft: DraftScope): boolean {
  switch (draft.kind) {
    case "library":
      return true;
    case "folder":
      return draft.folderId !== "";
    case "books":
      return draft.bookIds.length > 0;
    default: {
      const unhandled: never = draft;
      throw new Error(`unhandled draft scope ${JSON.stringify(unhandled)}`);
    }
  }
}

export function SourcePicker({
  draft,
  onChange,
  folders,
  books,
  libraryNote,
}: {
  draft: DraftScope;
  onChange: (draft: DraftScope) => void;
  folders: FolderOption[];
  books: BookOption[];
  libraryNote: string;
}) {
  const [find, setFind] = useState("");
  const picked = new Set(draft.kind === "books" ? draft.bookIds : []);
  const matching = matchBooks(books, find);
  // Ticked books lead, so the cap can never hide a choice already made
  const shownBooks = [...matching.filter((book) => picked.has(book.id)), ...matching.filter((book) => !picked.has(book.id))].slice(0, SHOWN_BOOKS);

  const pickKind = (kind: string) => {
    if (kind === draft.kind) return;
    if (kind === "folder") onChange({ kind: "folder", folderId: folders[0]?.id ?? "" });
    else if (kind === "books") onChange({ kind: "books", bookIds: [] });
    else onChange({ kind: "library" });
  };

  const toggle = (bookId: string) => {
    const next = new Set(picked);
    if (!next.delete(bookId)) next.add(bookId);
    onChange({ kind: "books", bookIds: books.filter((book) => next.has(book.id)).map((book) => book.id) });
  };

  return (
    <div className="mt-8 flex flex-col gap-3" data-testid="chat-source-picker">
      <div>
        <h2 className="text-xl font-bold text-(--text-primary)">What should this chat search?</h2>
        <p className="mt-1 text-sm text-(--text-muted)">The selection locks in with your first question. Pick again by starting another chat.</p>
      </div>
      <div className="self-start">
        <SegmentedControl
          testId="chat-scope"
          value={draft.kind}
          onChange={pickKind}
          options={KINDS.map((kind) => ({
            id: kind.id,
            label: kind.label,
            disabled: kind.id === "folder" && folders.length === 0,
            title: kind.id === "folder" && folders.length === 0 ? "There are no folders yet" : undefined,
          }))}
        />
      </div>

      {draft.kind === "books" && (
        <div className="overflow-hidden rounded-lg border border-(--border) bg-(--bg-card)">
          <label className="flex h-8 items-center gap-1.5 border-b border-(--border) px-3 text-(--text-faint)">
            <IconSearch className="h-3 w-3 shrink-0" />
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Find a book by title or author"
              className="min-w-0 flex-1 bg-transparent text-xs text-(--text-primary) outline-none"
              data-testid="chat-book-find"
            />
            <span className="shrink-0 text-xs" data-testid="chat-book-count">
              {picked.size > 0 && (
                <>
                  {picked.size} picked ·{" "}
                  <button type="button" onClick={() => onChange({ kind: "books", bookIds: [] })} className="text-(--accent-text) hover:underline" data-testid="chat-book-clear">
                    clear
                  </button>
                  {" · "}
                </>
              )}
              {shownBooks.length < matching.length ? `Showing ${shownBooks.length} of ${matching.length} · type to narrow` : `${matching.length} of ${books.length}`}
            </span>
          </label>
          <div className="divide-y divide-(--border)">
            {shownBooks.map((book) => (
              <label
                key={book.id}
                className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-(--bg-card-hover) ${picked.has(book.id) ? "bg-(--bg-selected)" : ""}`}
                data-testid="chat-book-option"
              >
                <input type="checkbox" checked={picked.has(book.id)} onChange={() => toggle(book.id)} className="h-3.5 w-3.5 accent-(--accent)" />
                <IconBook className="h-4 w-4 shrink-0 text-(--text-faint)" />
                <span className="min-w-0 flex-1 truncate text-sm text-(--text-primary)">{book.title}</span>
                {book.author && <span className="max-w-40 shrink-0 truncate text-xs text-(--text-faint)">{book.author}</span>}
              </label>
            ))}
            {shownBooks.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-(--text-muted)">{books.length === 0 ? "The library has no books yet." : "No title matches."}</p>
            )}
          </div>
        </div>
      )}

      {draft.kind === "folder" && (
        <>
          <div className="self-start">
            <Dropdown
              value={draft.folderId}
              onChange={(folderId) => onChange({ kind: "folder", folderId })}
              testId="chat-scope-folder"
              options={folders.map((folder) => ({ value: folder.id, label: `${"  ".repeat(folder.depth)}${folder.name}` }))}
            />
          </div>
          <p className="text-xs text-(--text-faint)">A folder searches whatever is in it when you ask, so later additions count too.</p>
        </>
      )}

      {draft.kind === "library" && <p className="text-xs text-(--text-muted)">{libraryNote}</p>}
    </div>
  );
}
