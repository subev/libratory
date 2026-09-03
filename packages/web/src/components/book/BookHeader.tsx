import type { ReactNode } from "react";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { Button } from "../Button.tsx";
import { EditableTitle } from "../EditableTitle.tsx";
import { Menu, MenuDivider, MenuItem } from "../Menu.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { VariantMenu, type VariantLane } from "./VariantMenu.tsx";
import { useShellLayout } from "./BookShell.tsx";
import {
  IconAi,
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconChat,
  IconDisk,
  IconMore,
  IconRefresh,
  IconSettings,
} from "../icons.tsx";

type IndexState = { dot: string; hint: string; pulse: boolean };

// Chat's dot is the only place the search index is visible on this page. The numbers the design puts
// in its tooltip ("embedding 48 of 71") are not available: SearchIndexJob.progress is a prose string
// written every fifth batch, so this says which of the three states it is in and stops there.
function indexState(searchIndex: { status?: string } | null | undefined, hasChapters: boolean): IndexState {
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

export function BookHeader({
  bookId,
  title,
  headMeta,
  crumbs,
  searchIndex,
  hasChapters,
  onRename,
  prevBook,
  nextBook,
  position,
  onNavigate,
  canRead,
  readTitle,
  onAsk,
  lanes,
  activeVariant,
  bookLanguage,
  chapterCount,
  onSwitchVariant,
  onAddVariant,
  addVariantDisabled,
  addVariantTitle,
  onExtract,
  extractDisabled,
  extractTitle,
  onDetails,
  onDiskUsage,
  diskTotal,
  deleteAudio,
  onDeleteBook,
  extraMenuItems,
}: {
  bookId: string;
  title: string;
  headMeta: string;
  crumbs: { to?: string; label: string }[];
  searchIndex: { status?: string } | null | undefined;
  hasChapters: boolean;
  onRename: (title: string) => void;
  prevBook: { id: string; title: string } | null;
  nextBook: { id: string; title: string } | null;
  position: { index: number; total: number; sortKey: string } | null;
  onNavigate: (id: string) => void;
  canRead: boolean;
  readTitle: string;
  onAsk: () => void;
  lanes: VariantLane[];
  activeVariant: string | null;
  bookLanguage: string | null;
  chapterCount: number;
  onSwitchVariant: (key: string | null) => void;
  onAddVariant: () => void;
  addVariantDisabled: boolean;
  addVariantTitle: string;
  onExtract: () => void;
  extractDisabled: boolean;
  extractTitle: string;
  onDetails: () => void;
  onDiskUsage: () => void;
  diskTotal: string | null;
  deleteAudio: { count: number; size: string; disabled: boolean; title: string; onDelete: () => void };
  onDeleteBook: () => void;
  extraMenuItems?: ReactNode;
}) {
  const layout = useShellLayout();

  return (
    <div className="flex items-center gap-3 h-12 px-4 border-b border-(--border) bg-(--bg-card)">
      <Breadcrumbs items={crumbs} />

      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="icon"
          size="sm"
          onClick={() => prevBook && onNavigate(prevBook.id)}
          disabled={!prevBook}
          title={prevBook ? `Previous book: "${prevBook.title}" — press [` : "This is the first book in the list"}
          aria-label="Previous book"
          data-testid="prev-book"
        >
          <IconArrowLeft className="h-4 w-4" />
        </Button>
        {position && layout.showPosition && (
          <span
            className="text-xs text-(--text-faint) tabular-nums"
            title={`Position in the home list's current sort (${position.sortKey})`}
          >
            {position.index} of {position.total}
          </span>
        )}
        <Button
          variant="icon"
          size="sm"
          onClick={() => nextBook && onNavigate(nextBook.id)}
          disabled={!nextBook}
          title={nextBook ? `Next book: "${nextBook.title}" — press ]` : "This is the last book in the list"}
          aria-label="Next book"
          data-testid="next-book"
        >
          <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="w-px h-5 bg-(--border) shrink-0" />

      <div className="min-w-0 flex items-baseline gap-3">
        <EditableTitle title={title} onRename={onRename} className="text-lg font-semibold text-(--text-primary) truncate" />
        {layout.showHeadMeta && <span className="text-xs text-(--text-muted) whitespace-nowrap shrink-0">{headMeta}</span>}
      </div>

      <div className="flex-1" />

      <ChatLink bookId={bookId} state={indexState(searchIndex, hasChapters)} showLabel={layout.showLabels} />

      <Button variant="secondary" size="sm" onClick={onAsk} title="Ask AI about this book — one call, the whole text goes to the model" data-testid="book-ask-ai">
        <IconAi className="h-4 w-4" />
        {layout.showLabels && "Ask AI"}
      </Button>

      <Button variant="secondary" size="sm" to={`/books/${bookId}/read`} disabled={!canRead} title={readTitle} data-testid="book-read-link">
        <IconBook className="h-4 w-4" />
        {layout.showLabels && "Read"}
      </Button>

      <VariantMenu
        lanes={lanes}
        active={activeVariant}
        bookLanguage={bookLanguage}
        chapterCount={chapterCount}
        onSwitch={onSwitchVariant}
        onAdd={onAddVariant}
        addDisabled={addVariantDisabled}
        addTitle={addVariantTitle}
      />

      <ThemeToggle />

      <Menu
        align="right"
        testId="book-menu"
        trigger={({ open, toggle }) => (
          <Button variant="icon" size="sm" onClick={toggle} aria-expanded={open} aria-label="Book menu" data-testid="book-menu-trigger">
            <IconMore className="h-4 w-4" />
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                onDetails();
                close();
              }}
              icon={<IconSettings className="h-3.5 w-3.5 shrink-0" />}
              testId="open-book-details"
            >
              Book details…
            </MenuItem>
            <MenuItem
              onClick={() => {
                onExtract();
                close();
              }}
              disabled={extractDisabled}
              title={extractTitle}
              icon={<IconRefresh className="h-3.5 w-3.5 shrink-0" />}
              testId="book-menu-extract"
            >
              Re-extract chapters…
            </MenuItem>
            <MenuItem
              onClick={() => {
                onDiskUsage();
                close();
              }}
              icon={<IconDisk className="h-3.5 w-3.5 shrink-0" />}
              title="Disk space used by this book — a breakdown and a cleanup"
              testId="disk-usage"
            >
              Disk usage{diskTotal ? ` — ${diskTotal}` : ""}
            </MenuItem>
            {extraMenuItems}
            <MenuDivider />
            <MenuItem
              onClick={() => {
                deleteAudio.onDelete();
                close();
              }}
              disabled={deleteAudio.disabled}
              title={deleteAudio.title}
              danger
              testId="delete-audio-selected"
            >
              Delete audio of {deleteAudio.count} selected{deleteAudio.count > 0 ? ` · ${deleteAudio.size}` : ""}…
            </MenuItem>
            <MenuItem
              onClick={() => {
                onDeleteBook();
                close();
              }}
              danger
              testId="delete-book"
            >
              Delete book…
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

function ChatLink({ bookId, state, showLabel }: { bookId: string; state: IndexState; showLabel: boolean }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      to={`/chat?bookId=${bookId}`}
      title={`Chat about this book — searches its text and translations, cites pages · ${state.hint}`}
      data-testid="book-chat-link"
    >
      <IconChat className="h-4 w-4" />
      {showLabel && "Chat"}
      <span
        title={state.hint}
        className={`w-1.5 h-1.5 rounded-full ${state.dot} ${state.pulse ? "animate-[pulse-dot_1.15s_ease-in-out_infinite]" : ""}`}
      />
    </Button>
  );
}
