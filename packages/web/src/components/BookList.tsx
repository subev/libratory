import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "../trpc.ts";
import { formatBytes, formatRelativeTime } from "../lib/format.ts";
import { loadBookSort, saveBookSort, sortBooks, sortFolders, type BookSortDir, type BookSortKey, type FolderRow } from "../lib/book-sort.ts";
import { DigestModal } from "./DigestModal.tsx";
import { HnDigestModal } from "./HnDigestModal.tsx";
import { FolderPickerModal } from "./FolderPickerModal.tsx";
import { setDragItems, getDragItems, hasDragItems, type DragItems } from "../lib/dnd.ts";
import { statusStyles } from "./StatusBadge.tsx";
import { IconBook, IconCheck, IconChevronDown, IconChevronUp, IconDelete, IconFolder, IconMore, IconRename, IconUpload } from "./icons.tsx";
import { Button } from "./Button.tsx";
import { Menu, MenuDivider, MenuItem } from "./Menu.tsx";
import { ActionTray } from "./ActionTray.tsx";
import { matchesFilter, type LibraryFilter } from "../lib/library-filter.ts";
import { useLibraryLayout } from "./library/LibraryShell.tsx";
import type { BookRow } from "../lib/book-sort.ts";

type SortKey = BookSortKey;
type SortDir = BookSortDir;

function ActivityPill({ label, status, pulse = true }: { label: string; status: keyof typeof statusStyles; pulse?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${statusStyles[status] ?? statusStyles.pending}`}>
      {pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {label}
    </span>
  );
}

function FolderTableRow({
  folder,
  selected,
  onToggleSelect,
  onDragStartRow,
  onDropItems,
}: {
  folder: FolderRow;
  selected: boolean;
  onToggleSelect: () => void;
  onDragStartRow: (e: React.DragEvent) => void;
  onDropItems: (items: DragItems) => void;
}) {
  const utils = trpc.useUtils();
  const layout = useLibraryLayout();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const [dragOver, setDragOver] = useState(false);
  const renameMutation = trpc.folders.rename.useMutation({
    onSuccess: () => utils.books.list.invalidate(),
  });
  const deleteMutation = trpc.folders.delete.useMutation({
    onSuccess: () => utils.books.list.invalidate(),
  });

  function saveRename() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== folder.name) renameMutation.mutate({ id: folder.id, name: trimmed });
    else setName(folder.name);
    setRenaming(false);
  }

  async function deleteFolder() {
    const stats = await utils.folders.deleteStats.fetch({ id: folder.id });
    const subfolders = stats.folderCount - 1;
    if (!confirm(
      `Delete folder "${folder.name}" and everything in it?\n\nThis permanently deletes ${stats.bookCount} book(s)` +
      (subfolders > 0 ? ` and ${subfolders} subfolder(s)` : "") +
      ` including all audio and files.`,
    )) return;
    deleteMutation.mutate({ id: folder.id });
  }

  return (
    <tr
      className={`hover:bg-(--bg-card-hover) ${selected ? "bg-(--bg-selected)" : ""} ${dragOver ? "outline outline-2 -outline-offset-2 outline-(--accent)" : ""}`}
      data-testid="folder-row"
      draggable
      onDragStart={onDragStartRow}
      onDragOver={(e) => {
        if (!hasDragItems(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const items = getDragItems(e);
        if (!items) return;
        e.preventDefault();
        onDropItems(items);
      }}
    >
      <td className="px-3 py-3">
        <input
          type="checkbox"
          checked={selected}
          onClick={onToggleSelect}
          readOnly
          className="rounded"
        />
      </td>
      <td className="px-4 py-3 max-w-md">
        <div className="flex items-center gap-2 group">
          {renaming ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename();
                if (e.key === "Escape") { setName(folder.name); setRenaming(false); }
              }}
              className="text-sm font-medium bg-transparent border-b border-(--accent) outline-none text-(--text-primary)"
            />
          ) : (
            <Link to={`/folders/${folder.id}`} className="inline-flex items-center gap-1.5 text-(--text-primary) hover:text-(--accent-text-hover) font-medium">
              <IconFolder className="h-4 w-4 shrink-0" />
              {folder.name}
            </Link>
          )}
          <button
            onClick={() => setRenaming(true)}
            disabled={renaming}
            title="Rename folder"
            className="text-(--text-faint) hover:text-(--text-secondary) text-xs disabled:opacity-50"
          >
            <IconRename className="h-3 w-3" />
          </button>
          <button
            onClick={deleteFolder}
            disabled={deleteMutation.isPending}
            title="Delete folder and everything in it"
            className="text-(--text-faint) hover:text-(--danger-text) text-xs disabled:opacity-50"
            data-testid="delete-folder"
          >
            {deleteMutation.isPending ? "…" : <IconDelete className="h-3 w-3" />}
          </button>
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <span className="text-sm tabular-nums text-(--text-secondary)">{folder.bookCount}</span>
        <span className="block text-[11px] text-(--text-faint)">book{folder.bookCount === 1 ? "" : "s"}</span>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {folder.activeBookCount > 0 && (
            <ActivityPill label={`${folder.activeBookCount} active`} status="synthesizing" />
          )}
          {folder.failedBookCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap bg-(--badge-failed-bg) text-(--badge-failed-text)">
              {folder.failedBookCount} failed
            </span>
          )}
          {folder.activeBookCount === 0 && folder.failedBookCount === 0 && (
            <span className="text-xs text-(--text-faint)">—</span>
          )}
        </div>
      </td>
      {layout.showLangs && <td className="px-4 py-3"><span className="text-xs text-(--text-faint)">—</span></td>}
      {layout.showOutputs && <td className="px-4 py-3"><span className="text-xs text-(--text-faint)">—</span></td>}
      {layout.showSize && (
        <td className="px-4 py-3 text-right text-sm tabular-nums text-(--text-tertiary)">
          {formatBytes(folder.sizeBytes)}
        </td>
      )}
      <td className="px-4 py-3 text-right text-sm text-(--text-tertiary)" title={folder.lastActivityAt ? new Date(folder.lastActivityAt).toLocaleString() : undefined}>
        {folder.lastActivityAt ? formatRelativeTime(folder.lastActivityAt) : <span className="text-xs text-(--text-faint)">—</span>}
      </td>
      <td className="px-4 py-3" />
    </tr>
  );
}

function SortableTh({
  label,
  sortKey,
  align = "left",
  active,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  align?: "left" | "right";
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <th className={`px-4 py-3 ${align === "right" ? "text-right" : "text-left"} text-xs font-medium text-(--text-muted) uppercase tracking-wider`}>
      <button
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-(--text-secondary) ${active ? "text-(--text-secondary)" : ""}`}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <span className={`text-[9px] ${active ? "" : "invisible"}`}>{dir === "asc" ? <IconChevronUp className="h-3 w-3" /> : <IconChevronDown className="h-3 w-3" />}</span>
      </button>
    </th>
  );
}

// Read is the one action worth a button of its own; the rest live behind the overflow so a row of
// nine columns does not end in a row of buttons.
function BookRowActions({
  book,
  onMove,
  onDelete,
}: {
  book: BookRow;
  onMove: (id: string) => void;
  onDelete: (book: BookRow) => void;
}) {
  // The reader opens on audio or on pages — the same gate the book page applies, which is why
  // books.list carries hasPages at all: a reader-mode book has no audio and is still readable.
  const canRead = book.chaptersWithAudio > 0 || book.hasPages;

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="icon"
        size="sm"
        to={`/books/${book.id}/read`}
        disabled={!canRead}
        title={canRead ? "Open the read-along reader" : "Nothing to read yet — this book has no audio and no pages"}
        aria-label={`Read ${book.title}`}
        data-testid="row-read"
      >
        <IconBook className="h-4 w-4" />
      </Button>
      <Menu
        testId="book-row-menu"
        width="w-52"
        trigger={({ toggle }) => (
          <Button variant="icon" size="sm" onClick={toggle} title="More actions" aria-label={`More actions for ${book.title}`}>
            <IconMore className="h-4 w-4" />
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuItem icon={<IconFolder className="h-4 w-4" />} onClick={() => { close(); onMove(book.id); }} testId="row-move">
              Move to folder…
            </MenuItem>
            <MenuDivider />
            <MenuItem danger icon={<IconDelete className="h-4 w-4" />} onClick={() => { close(); onDelete(book); }} testId="row-delete">
              Delete book…
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

export function BookList({
  folderId = null,
  filter = "all",
  onClearFilter,
  onAddBooks,
}: {
  folderId?: string | null;
  filter?: LibraryFilter;
  onClearFilter: () => void;
  onAddBooks: () => void;
}) {
  const utils = trpc.useUtils();
  const layout = useLibraryLayout();
  const { data, isLoading } = trpc.books.list.useQuery({ folderId }, {
    refetchInterval: 3000,
  });
  const books = data?.books;
  const folderRows = data?.folders ?? [];

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [showDigest, setShowDigest] = useState(false);
  const [showHnDigest, setShowHnDigest] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ bookIds: string[]; folderIds: string[] } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const deleteManyMutation = trpc.books.deleteMany.useMutation({
    onSuccess: () => {
      setSelectedIds(new Set());
      utils.books.list.invalidate();
    },
  });
  const deleteFolderMutation = trpc.folders.delete.useMutation();
  const moveBooksMutation = trpc.books.moveToFolder.useMutation();
  const moveFolderMutation = trpc.folders.move.useMutation();

  const [sortKey, setSortKey] = useState<SortKey>(() => loadBookSort().key);
  const [sortDir, setSortDir] = useState<SortDir>(() => loadBookSort().dir);

  function handleSort(key: SortKey) {
    const dir = key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : key === "title" ? "asc" : "desc";
    setSortKey(key);
    setSortDir(dir);
    saveBookSort(key, dir);
  }

  if (isLoading) {
    return <p className="text-(--text-muted) py-4">Loading...</p>;
  }

  const sorted = sortBooks((books ?? []).filter((b) => matchesFilter(b, filter)), sortKey, sortDir);
  const sortedFolders = sortFolders(folderRows, sortKey, sortDir);
  const isEmpty = sorted.length === 0 && folderRows.length === 0;

  // Prune ids of rows deleted/moved elsewhere so counts never lie
  const selectedBooks = sorted.filter((b) => selectedIds.has(b.id));
  const selectedCount = selectedBooks.length;
  const selectedFolders = folderRows.filter((f) => selectedFolderIds.has(f.id));
  const selectedFolderCount = selectedFolders.length;
  const totalSelected = selectedCount + selectedFolderCount;
  const allSelected = selectedCount === sorted.length && sorted.length > 0;

  const selectionLabel = [
    selectedCount > 0 ? `${selectedCount} book${selectedCount === 1 ? "" : "s"}` : null,
    selectedFolderCount > 0 ? `${selectedFolderCount} folder${selectedFolderCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" and ");

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectedFolderIds(new Set());
  }

  // Dragging a selected row drags the whole selection; an unselected row drags alone
  function dragItemsFor(kind: "book" | "folder", id: string): DragItems {
    const inSelection = kind === "book" ? selectedIds.has(id) : selectedFolderIds.has(id);
    if (inSelection && totalSelected > 0) {
      return { bookIds: selectedBooks.map((b) => b.id), folderIds: selectedFolders.map((f) => f.id) };
    }
    return kind === "book" ? { bookIds: [id], folderIds: [] } : { bookIds: [], folderIds: [id] };
  }

  async function dropItemsInto(targetFolderId: string, items: DragItems) {
    const folderIds = items.folderIds.filter((id) => id !== targetFolderId);
    if (items.bookIds.length === 0 && folderIds.length === 0) return;
    setDropError(null);
    try {
      if (items.bookIds.length > 0) {
        await moveBooksMutation.mutateAsync({ ids: items.bookIds, folderId: targetFolderId });
      }
      for (const id of folderIds) {
        await moveFolderMutation.mutateAsync({ id, parentId: targetFolderId });
      }
      clearSelection();
    } catch (err) {
      setDropError(err instanceof Error ? err.message : String(err));
    } finally {
      utils.books.list.invalidate();
      utils.folders.list.invalidate();
    }
  }

  function handleCheckboxClick(bookId: string, index: number, e: React.MouseEvent) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const select = !prev.has(bookId);
      if (e.shiftKey && lastClickedIndex !== null) {
        for (const b of sorted.slice(Math.min(lastClickedIndex, index), Math.max(lastClickedIndex, index) + 1)) {
          if (select) next.add(b.id);
          else next.delete(b.id);
        }
      } else if (select) next.add(bookId);
      else next.delete(bookId);
      return next;
    });
    setLastClickedIndex(index);
  }

  async function deleteSelected() {
    const titles = [...selectedFolders.map((f) => `Folder "${f.name}"`), ...selectedBooks.map((b) => `"${b.title}"`)]
      .slice(0, 5).join(", ");
    const suffix = totalSelected > 5 ? `, and ${totalSelected - 5} more` : "";
    const folderWarning = selectedFolderCount > 0 ? " Deleting a folder permanently removes ALL books and subfolders inside it." : "";
    if (!confirm(`Delete ${selectionLabel} with all their chapters, audio, and files?${folderWarning}\n\n${titles}${suffix}`)) return;
    for (const f of selectedFolders) {
      await deleteFolderMutation.mutateAsync({ id: f.id }).catch(() => {});
    }
    if (selectedBooks.length > 0) {
      deleteManyMutation.mutate({ ids: selectedBooks.map((b) => b.id) });
    } else {
      clearSelection();
      utils.books.list.invalidate();
    }
    setSelectedFolderIds(new Set());
  }

  const trayTitle =
    totalSelected === 0 ? "Nothing selected"
    : selectedFolders.length > 0 ? `${selectedCount} books · ${selectedFolders.length} folders`
    : selectedCount === sorted.length ? `All ${selectedCount} books selected`
    : `${selectedCount} selected`;
  const traySub =
    totalSelected === 0
      ? "Shift-click a checkbox to take a range"
      : `${selectedBooks.reduce((n, b) => n + b.chapterCount, 0)} chapters · ${selectedBooks.filter((b) => b.searchIndex?.status === "done").length} indexed`;

  const th = (label: string, key: SortKey, align?: "left" | "right") => (
    <SortableTh label={label} sortKey={key} align={align} active={sortKey === key} dir={sortDir} onSort={handleSort} />
  );

  return (
    <>
      {(deleteManyMutation.error || dropError) && (
        <p className="px-4 pt-3 text-sm text-(--danger-text)" data-testid="library-error">
          {deleteManyMutation.error?.message ?? dropError}
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">
      {isEmpty ? (
        <p className="text-(--text-muted) py-4">
          {folderId ? "This folder is empty." : "No books yet. Upload a PDF to get started."}
        </p>
      ) : (
      <div className="rounded-lg border border-(--border)">
      <table className="w-full divide-y divide-(--divide)">
        <thead className="bg-(--bg-subtle)">
          <tr>
            <th className="w-10 px-3 py-3">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = !allSelected && selectedCount > 0; }}
                onChange={() => setSelectedIds(allSelected ? new Set() : new Set(sorted.map((b) => b.id)))}
                title={allSelected ? "Deselect all" : "Select all"}
                className="rounded"
              />
            </th>
            {th("Title", "title")}
            {th("Ch.", "chapters", "right")}
            <th className="px-4 py-2 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">Status</th>
            {layout.showLangs && th("Languages", "langs")}
            {layout.showOutputs && th("Outputs", "outputs")}
            {layout.showSize && th("Size", "size", "right")}
            {th("Last activity", "lastActivity", "right")}
            <th className="px-4 py-2 w-24" />
          </tr>
        </thead>
        <tbody className="bg-(--bg-card) divide-y divide-(--divide)">
          {sortedFolders.map((folder) => (
            <FolderTableRow
              key={folder.id}
              folder={folder}
              selected={selectedFolderIds.has(folder.id)}
              onToggleSelect={() =>
                setSelectedFolderIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(folder.id)) next.delete(folder.id);
                  else next.add(folder.id);
                  return next;
                })
              }
              onDragStartRow={(e) => setDragItems(e, dragItemsFor("folder", folder.id))}
              onDropItems={(items) => dropItemsInto(folder.id, items)}
            />
          ))}
          {sorted.map((book, bookIndex) => {
            const totalFailures =
              book.failures.files + book.failures.chapters + book.failures.translations + book.failures.cleanup;
            const failureDetail = [
              book.failures.files > 0 ? `${book.failures.files} file(s)` : null,
              book.failures.chapters > 0 ? `${book.failures.chapters} chapter(s)` : null,
              book.failures.translations > 0 ? `${book.failures.translations} translation(s)` : null,
              book.failures.cleanup > 0 ? `${book.failures.cleanup} cleanup(s)` : null,
            ].filter(Boolean).join(", ");
            const idle =
              !book.activity.extracting && !book.activity.assembling && !book.activity.aiNote && !book.activity.digest &&
              book.activity.synthesizing === 0 && book.activity.translating === 0 && book.activity.cleaning === 0;
            const noText = !book.hasText && book.kind === "pdf" && !book.activity.extracting;
            const outputParts = [
              book.outputs.assemblies > 0 ? `${book.outputs.assemblies} M4B` : null,
              book.outputs.pdfs > 0 ? `${book.outputs.pdfs} PDF` : null,
              book.outputs.epubs > 0 ? `${book.outputs.epubs} EPUB` : null,
            ].filter(Boolean);

            return (
              <tr
                key={book.id}
                className={`hover:bg-(--bg-card-hover) ${selectedIds.has(book.id) ? "bg-(--bg-selected)" : ""}`}
                draggable
                onDragStart={(e) => setDragItems(e, dragItemsFor("book", book.id))}
              >
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(book.id)}
                    onClick={(e) => handleCheckboxClick(book.id, bookIndex, e)}
                    readOnly
                    className="rounded"
                  />
                </td>
                <td className="px-4 py-3 max-w-md">
                  <Link to={`/books/${book.id}`} className="text-(--accent-text) hover:text-(--accent-text-hover) font-medium">
                    {book.title}
                  </Link>
                  {book.kind === "digest" && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--bg-subtle) text-(--text-secondary) align-middle" data-testid="digest-badge" title="Digest — AI summary chapters from other books">
                      digest
                    </span>
                  )}
                  {book.kind === "api" && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--bg-subtle) text-(--text-secondary) align-middle" data-testid="api-badge" title="Created through the external API by a script or another project">
                      api
                    </span>
                  )}
                  {book.skipSynthesis && book.kind === "pdf" && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--bg-subtle) text-(--text-muted) align-middle" title="Reader mode — extraction only, audio on demand">
                      reader
                    </span>
                  )}
                  {book.searchIndex && ["queued", "chunking", "embedding"].includes(book.searchIndex.status) && (
                    <span
                      className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--bg-subtle) text-(--text-muted) align-middle animate-pulse"
                      title={`Search indexing: ${book.searchIndex.status}${book.searchIndex.progress ? ` — ${book.searchIndex.progress}` : ""}`}
                      data-testid="index-badge"
                    >
                      indexing…
                    </span>
                  )}
                  {book.searchIndex?.status === "done" && (
                    <span
                      className="ml-2 inline-flex items-center text-(--text-faint) align-middle"
                      title="Fully indexed — findable in library chat (keyword + semantic search)"
                      data-testid="index-badge-done"
                    >
                      <IconCheck className="h-3 w-3" />
                    </span>
                  )}
                  {book.searchIndex?.status === "waiting" && (
                    <span
                      className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--bg-subtle) text-(--text-muted) align-middle"
                      title="Keyword search works. Semantic search needs the BGE-M3 models — download them from the chat page and this indexes itself."
                      data-testid="index-badge-waiting"
                    >
                      search pending
                    </span>
                  )}
                  {book.searchIndex?.status === "failed" && (
                    <span
                      className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--badge-failed-bg) text-(--badge-failed-text) align-middle"
                      title={`Search indexing failed: ${book.searchIndex.error ?? "unknown error"}`}
                      data-testid="index-badge-failed"
                    >
                      index failed
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-sm tabular-nums text-(--text-secondary)">{book.chapterCount}</span>
                  {book.chaptersWithAudio > 0 && (
                    <span className="block text-[11px] text-(--text-faint) tabular-nums" title={`${book.chaptersWithAudio} chapters have audio`}>
                      {book.chaptersWithAudio} audio
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {book.activity.extracting && (
                      <ActivityPill label="extracting" status="extracting" />
                    )}
                    {book.activity.synthesizing > 0 && (
                      <ActivityPill label={`synthesizing ${book.activity.synthesizing}`} status="synthesizing" />
                    )}
                    {book.activity.translating > 0 && (
                      <ActivityPill label={`translating ${book.activity.translating}`} status="synthesizing" />
                    )}
                    {book.activity.cleaning > 0 && (
                      <ActivityPill label={`cleaning ${book.activity.cleaning}`} status="cleaning" />
                    )}
                    {book.activity.assembling && (
                      <ActivityPill label="assembling" status="assembling" />
                    )}
                    {book.activity.aiNote && (
                      <ActivityPill label="AI note" status="synthesizing" />
                    )}
                    {book.activity.digest && (
                      <ActivityPill label="digesting" status="synthesizing" />
                    )}
                    {(totalFailures > 0 || book.failed) && (
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-(--badge-failed-bg) text-(--badge-failed-text)"
                        title={totalFailures > 0 ? `Failed: ${failureDetail}${book.error ? ` — ${book.error}` : ""}` : book.error ?? "Failed"}
                      >
                        {totalFailures > 0 ? `${totalFailures} failed` : "failed"}
                      </span>
                    )}
                    {noText && (
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-(--warning-bg) text-(--warning-text)"
                        title="No text extracted — the PDF is likely scanned. Open the book and extract with Force OCR. Without text it can't be used in digests or Ask AI."
                        data-testid="no-text-pill"
                      >
                        no text
                      </span>
                    )}
                    {idle && totalFailures === 0 && !book.failed && !noText && <span className="text-xs text-(--text-faint)">—</span>}
                  </div>
                </td>
                {layout.showLangs && (
                <td className="px-4 py-3">
                  {book.languages.length === 0 ? (
                    <span className="text-xs text-(--text-faint)">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {book.languages.map((l) => (
                        <span
                          key={l.language}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border border-(--border) text-(--text-secondary)"
                          title={`${l.done} of ${book.chapterCount} chapters have ${l.label ?? l.language} text`}
                        >
                          {l.label ?? l.language} {l.done}/{book.chapterCount}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                )}
                {layout.showOutputs && (
                  <td className="px-4 py-3 text-sm text-(--text-tertiary)">
                    {outputParts.length === 0 ? <span className="text-xs text-(--text-faint)">—</span> : outputParts.join(" · ")}
                  </td>
                )}
                {layout.showSize && (
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-(--text-tertiary)">
                    {formatBytes(book.sizeBytes)}
                  </td>
                )}
                <td
                  className="px-4 py-3 text-right text-sm text-(--text-tertiary)"
                  title={`Created ${new Date(book.createdAt).toLocaleDateString()} · last activity ${new Date(book.lastActivityAt).toLocaleString()}`}
                >
                  {formatRelativeTime(book.lastActivityAt)}
                </td>
                <td className="px-4 py-3">
                  <BookRowActions
                    book={book}
                    onMove={(id) => setMoveTarget({ bookIds: [id], folderIds: [] })}
                    onDelete={(b) => {
                      if (confirm(`Delete “${b.title}” and everything made from it?`)) {
                        deleteManyMutation.mutate({ ids: [b.id] });
                      }
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* Folders are navigation, not results, so they survive a filter — which means the list is
          not "empty" and the message above never fires for a filter that matches no book. */}
      {sorted.length === 0 && filter !== "all" && (
        <div className="flex flex-col items-center gap-2 py-12 text-(--text-muted)" data-testid="no-books-in-filter">
          <IconBook className="h-6 w-6 text-(--text-faint)" />
          <span className="text-sm">No book in this filter.</span>
          <Button size="sm" onClick={onClearFilter} data-testid="clear-filter">Clear filters</Button>
        </div>
      )}
      </div>
      )}
      </div>

      <ActionTray
        compact={layout.trayCompact}
        title={trayTitle}
        subtitle={traySub}
        actions={[
          {
            id: "create-digest",
            label: `Create digest (${selectedCount})`,
            onClick: () => setShowDigest(true),
            disabled: selectedCount < 2,
            title: selectedCount < 2
              ? "Select at least 2 books with the checkboxes"
              : "Create a digest book — one AI summary chapter per selected book, ready to listen to",
            pinned: true,
          },
          {
            id: "hn-digest",
            label: "HN digest",
            onClick: () => setShowHnDigest(true),
            title: "Build a podcast-style book from a day's top Hacker News stories",
          },
          {
            id: "move-to-folder",
            label: `Move to folder (${totalSelected})`,
            onClick: () => setMoveTarget({ bookIds: selectedBooks.map((b) => b.id), folderIds: selectedFolders.map((f) => f.id) }),
            disabled: totalSelected === 0,
            title: totalSelected === 0
              ? "Select books or folders to move with the checkboxes"
              : "Move the selection into a folder — or drag rows onto a folder",
          },
          {
            id: "delete-selected-books",
            label: deleteManyMutation.isPending || deleteFolderMutation.isPending
              ? "Deleting..."
              : `Delete selected (${totalSelected})`,
            onClick: deleteSelected,
            disabled: totalSelected === 0 || deleteManyMutation.isPending || deleteFolderMutation.isPending,
            title: totalSelected === 0
              ? "Select books or folders to delete with the checkboxes"
              : "Delete the selection with all its chapters, audio, and files",
            danger: true,
            pinned: true,
          },
        ]}
        primary={
          <Button variant="primary" size="sm" onClick={onAddBooks} data-testid="tray-add-books">
            <IconUpload className="h-4 w-4" />
            Add books
          </Button>
        }
      />

      {showDigest && (
        <DigestModal
          sourceBooks={selectedBooks.map((b) => ({ id: b.id, title: b.title }))}
          folderId={folderId}
          onClose={() => setShowDigest(false)}
        />
      )}
      {showHnDigest && <HnDigestModal onClose={() => setShowHnDigest(false)} />}
      {moveTarget && (
        <FolderPickerModal
          bookIds={moveTarget.bookIds}
          folderIds={moveTarget.folderIds}
          onClose={() => setMoveTarget(null)}
          onMoved={() => {
            setMoveTarget(null);
            clearSelection();
          }}
        />
      )}
    </>
  );
}
