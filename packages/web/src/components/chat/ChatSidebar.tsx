import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "../../trpc.ts";
import { Button } from "../Button.tsx";
import { Dropdown } from "../Dropdown.tsx";
import { Menu, MenuDivider, MenuItem } from "../Menu.tsx";
import { Modal, ModalHeader } from "../Modal.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import {
  IconAdd,
  IconBook,
  IconBookRemoved,
  IconBooks,
  IconChats,
  IconClose,
  IconDelete,
  IconExternal,
  IconFilter,
  IconFolder,
  IconMore,
  IconRename,
  IconSearch,
} from "../icons.tsx";
import {
  filterActive,
  filterBookOptions,
  filterConversations,
  formatWhen,
  groupByDay,
  NO_FILTER,
  scopeSummary,
  type BookFilterMode,
  type ConversationSummary,
  type HistoryFilter,
  type ScopeSummary,
} from "../../lib/chat-history.ts";

const SCOPE_ICONS: Record<ScopeSummary["kind"], typeof IconBook> = {
  library: IconBooks,
  folder: IconFolder,
  book: IconBook,
  books: IconBooks,
  removed: IconBookRemoved,
};

const MODE_HINT: Record<BookFilterMode, string> = {
  scoped: "Chats where this book was picked as a source",
  cites: "Also wider chats that cited a passage from it",
};

function noResultsDetail(filter: HistoryFilter, bookTitle: string): string {
  const query = filter.search.trim();
  if (query && bookTitle) return `Nothing about ${bookTitle} mentions “${query}” in its title or questions.`;
  if (query) return `No title or question contains “${query}”.`;
  return filter.mode === "scoped" ? `No chat chose ${bookTitle}. Try “Quoted it”.` : `No chat chose or quoted ${bookTitle}.`;
}

export function ChatSidebar({
  conversations,
  activeId,
  filter,
  onFilter,
  onNewChat,
  onNavigate,
  onDeleted,
  onClose,
  savedAnswers,
  onShowSaved,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  filter: HistoryFilter;
  onFilter: (filter: HistoryFilter) => void;
  onNewChat: () => void;
  // A row was opened — the narrow-screen drawer closes on it
  onNavigate: () => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
  savedAnswers: number;
  onShowSaved: () => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const now = new Date();

  const bookOptions = filterBookOptions(conversations);
  const shown = filterConversations(conversations, filter);
  const active = filterActive(filter);
  const filterTitle = bookOptions.find((book) => book.id === filter.bookId)?.title ?? "";

  return (
    <>
      <div className="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
        <span className="flex-1 text-xs font-bold uppercase tracking-wide text-(--text-muted)">Conversations</span>
        <Button variant="primary" size="sm" onClick={onNewChat} data-testid="chat-new">
          <IconAdd className="h-3 w-3" />
          New chat
        </Button>
        <Button variant="icon" size="sm" onClick={onClose} aria-label="Close conversations" className="md:hidden">
          <IconClose className="h-4 w-4" />
        </Button>
      </div>

      {/* History filters live here and look like form fields; what a chat searches is chips in its own header */}
      <div className="flex flex-none flex-col gap-1.5 px-3 pb-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-(--border-input) bg-(--bg-page) px-2 text-(--text-faint)">
          <IconSearch className="h-3 w-3 shrink-0" />
          <input
            value={filter.search}
            onChange={(e) => onFilter({ ...filter, search: e.target.value })}
            placeholder="Search titles and questions"
            disabled={conversations.length === 0}
            className="min-w-0 flex-1 bg-transparent text-xs text-(--text-primary) outline-none"
            data-testid="chat-history-search"
          />
        </label>
        <div className="flex items-center gap-1.5">
          {/* The wrapper is what shrinks: a long title otherwise pushed Clear out past the sidebar's edge */}
          <div className="min-w-0 flex-1">
          <Dropdown
            value={filter.bookId}
            onChange={(bookId) => onFilter({ ...filter, bookId, mode: bookId ? filter.mode : "scoped" })}
            testId="chat-history-book"
            size="sm"
            fill
            disabled={bookOptions.length === 0}
            title="Show conversations about one book"
            icon={<IconFilter className="h-3 w-3" />}
            options={[
              { value: "", label: "Any book" },
              ...bookOptions.map((book) => ({ value: book.id, label: book.available ? book.title : `${book.title} — removed` })),
            ]}
          />
          </div>
          {active && (
            <Button variant="primary" soft size="sm" onClick={() => onFilter(NO_FILTER)} title="Clear filter and search" className="shrink-0" data-testid="chat-history-clear">
              Clear
            </Button>
          )}
        </div>
        {/* On its own row with the hint beneath: beside each other in a 288px sidebar, the labels truncated to "Chos…" and "Q…" */}
        {filter.bookId && (
          <div className="flex flex-col items-start gap-1" role="group" aria-label="Which conversations about this book">
            <SegmentedControl
              testId="chat-history-mode"
              size="sm"
              value={filter.mode}
              onChange={(mode) => onFilter({ ...filter, mode: mode === "cites" ? "cites" : "scoped" })}
              options={[
                { id: "scoped", label: "Chose this book", title: MODE_HINT.scoped },
                { id: "cites", label: "Quoted it", title: MODE_HINT.cites },
              ]}
            />
            <span className="text-xs leading-tight text-(--text-faint)">{MODE_HINT[filter.mode]}</span>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3" data-testid="chat-history">
        {conversations.length === 0 && (
          <div className="px-4 py-8 text-center text-xs leading-relaxed text-(--text-muted)">
            <IconChats className="mx-auto mb-2 h-6 w-6 text-(--text-faint)" />
            No conversations yet.
            <br />
            Ask something and it will be kept here.
          </div>
        )}
        {conversations.length > 0 && shown.length === 0 && (
          <div className="px-4 py-6 text-center text-xs leading-relaxed text-(--text-muted)" data-testid="chat-history-none">
            <p className="mb-1 text-(--text-secondary)">No conversations match.</p>
            <p className="mb-3">{noResultsDetail(filter, filterTitle)}</p>
            <Button variant="secondary" size="sm" onClick={() => onFilter(NO_FILTER)}>Clear filters</Button>
          </div>
        )}
        {groupByDay(shown, now).map((group) => (
          <div key={group.label}>
            <div className="px-2 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-(--text-faint)">{group.label}</div>
            {group.conversations.map((conversation) => (
              <HistoryRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                renaming={conversation.id === renamingId}
                now={now}
                onNavigate={onNavigate}
                onRename={() => setRenamingId(conversation.id)}
                onRenameDone={() => setRenamingId(null)}
                onDelete={() => setDeleting(conversation)}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Notes, not conversations: they outlive the chat they were saved from, so they sit apart from the list */}
      {savedAnswers > 0 && (
        <div className="flex-none border-t border-(--border) p-1.5">
          <Button variant="ghost" size="sm" onClick={onShowSaved} className="w-full" data-testid="chat-saved-answers">
            Saved answers ({savedAnswers})
          </Button>
        </div>
      )}

      {deleting && (
        <DeleteConversationModal
          conversation={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            onDeleted(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

function HistoryRow({
  conversation,
  active,
  renaming,
  now,
  onNavigate,
  onRename,
  onRenameDone,
  onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  renaming: boolean;
  now: Date;
  onNavigate: () => void;
  onRename: () => void;
  onRenameDone: () => void;
  onDelete: () => void;
}) {
  const utils = trpc.useUtils();
  const rename = trpc.chats.rename.useMutation({ onSuccess: () => utils.chats.list.invalidate() });
  const summary = scopeSummary(conversation.scope);
  const ScopeIcon = SCOPE_ICONS[summary.kind];
  const tone = summary.kind === "removed" ? "text-(--text-faint)" : "text-(--text-muted)";

  const commit = (title: string) => {
    const next = title.trim();
    if (next && next !== conversation.title) rename.mutate({ id: conversation.id, title: next });
    onRenameDone();
  };

  return (
    <div className="group relative" data-testid="chat-history-row">
      {renaming ? (
        <div className="py-1.5 pr-8 pl-2">
          <input
            autoFocus
            defaultValue={conversation.title}
            aria-label="Conversation title"
            onFocus={(e) => e.target.select()}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(e.currentTarget.value);
              if (e.key === "Escape") onRenameDone();
            }}
            className="w-full rounded border border-(--border-input) bg-(--bg-page) px-1.5 py-1 text-xs text-(--text-primary) outline-none"
            data-testid="chat-history-rename"
          />
        </div>
      ) : (
        // button-ok: a history row — one entry selected out of a list, not an action
        <Link
          to={`/chat/${conversation.id}`}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={`flex flex-col gap-0.5 rounded-md py-1.5 pr-8 pl-2 hover:bg-(--bg-card-hover) ${active ? "bg-(--bg-selected)" : ""}`}
        >
          <span className="line-clamp-2 text-xs leading-snug text-(--text-primary)">{conversation.title}</span>
          <span className={`flex min-w-0 items-center gap-1 text-xs ${tone}`}>
            <ScopeIcon className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{summary.label}</span>
            <span className="shrink-0 tabular-nums text-(--text-faint)">{formatWhen(conversation.updatedAt, now)}</span>
          </span>
        </Link>
      )}
      <div className={`absolute top-1 right-1 ${active ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}>
        <Menu
          testId="chat-history-menu"
          width="w-52"
          align="right"
          trigger={({ toggle }) => (
            <Button variant="icon" size="sm" onClick={toggle} aria-label={`Menu for ${conversation.title}`}>
              <IconMore className="h-4 w-4" />
            </Button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<IconRename className="h-4 w-4" />} onClick={() => { close(); onRename(); }} testId="chat-history-rename-item">
                Rename
              </MenuItem>
              <MenuItem icon={<IconExternal className="h-4 w-4" />} onClick={() => { close(); window.open(`/chat/${conversation.id}`, "_blank", "noopener"); }}>
                Open in new tab
              </MenuItem>
              <MenuDivider />
              <MenuItem danger icon={<IconDelete className="h-4 w-4" />} onClick={() => { close(); onDelete(); }} testId="chat-history-delete-item">
                Delete…
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}

function searchedPhrase(conversation: ConversationSummary): string {
  switch (conversation.scope.kind) {
    case "library":
      return "The library it searched";
    case "folder":
      return "The folder it searched";
    case "books":
      return conversation.scope.books.length === 1 ? "The book it searched" : `The ${conversation.scope.books.length} books it searched`;
    default: {
      const unhandled: never = conversation.scope;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}

function DeleteConversationModal({
  conversation,
  onClose,
  onDeleted,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const utils = trpc.useUtils();
  const remove = trpc.chats.delete.useMutation({
    onSuccess: async () => {
      await utils.chats.list.invalidate();
      onDeleted();
    },
  });
  const answers = conversation.answers === 1 ? "Its 1 answer is" : `Its ${conversation.answers} answers are`;

  return (
    <Modal size="sm" onClose={onClose} testId="chat-delete-modal">
      <ModalHeader title="Delete this conversation?" onClose={onClose} />
      <div className="space-y-2 px-4 pt-3 text-sm leading-relaxed text-(--text-secondary)">
        <p className="text-(--text-primary)">“{conversation.title}”</p>
        <p>{answers} removed. {searchedPhrase(conversation)} and any notes saved from it stay where they are.</p>
        {remove.error && <p className="text-(--danger-text)">{remove.error.message}</p>}
      </div>
      <div className="flex justify-end gap-2 p-4">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => remove.mutate({ id: conversation.id })} disabled={remove.isPending} data-testid="chat-delete-confirm">
          Delete
        </Button>
      </div>
    </Modal>
  );
}
