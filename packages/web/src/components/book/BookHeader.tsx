import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { Button } from "../Button.tsx";
import { AssistantToggle } from "../assistant/AssistantPanel.tsx";
import { EditableTitle } from "../EditableTitle.tsx";
import { Menu, MenuDivider, MenuItem } from "../Menu.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { VariantMenu, type VariantLane } from "./VariantMenu.tsx";
import { useShellLayout } from "./BookShell.tsx";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconDisk,
  IconMore,
  IconRefresh,
  IconSettings,
} from "../icons.tsx";


export function BookHeader({
  bookId,
  title,
  headMeta,
  crumbs,
  onRename,
  prevBook,
  nextBook,
  position,
  onNavigate,
  canRead,
  readTitle,
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
}: {
  bookId: string;
  title: string;
  headMeta: string;
  crumbs: { to?: string; label: string }[];
  onRename: (title: string) => void;
  prevBook: { id: string; title: string } | null;
  nextBook: { id: string; title: string } | null;
  position: { index: number; total: number; sortKey: string } | null;
  onNavigate: (id: string) => void;
  canRead: boolean;
  readTitle: string;
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

      <AssistantToggle />

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

