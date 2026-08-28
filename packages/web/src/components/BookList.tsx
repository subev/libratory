import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "../trpc.ts";
import { formatBytes, formatRelativeTime } from "../lib/format.ts";
import { loadBookSort, saveBookSort, sortBooks, sortFolders, type BookSortDir, type BookSortKey, type FolderRow } from "../lib/book-sort.ts";
import { DigestModal } from "./DigestModal.tsx";
import { HnDigestModal } from "./HnDigestModal.tsx";
import { FolderPickerModal } from "./FolderPickerModal.tsx";
import { setDragItems, getDragItems, hasDragItems, type DragItems } from "../lib/dnd.ts";

type SortKey = BookSortKey;
type SortDir = BookSortDir;

function ActivityPill({ label, color, pulse = true }: { label: string; color: string; pulse?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${color}`}>
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
            <Link to={`/folders/${folder.id}`} className="text-(--text-primary) hover:text-(--accent-text-hover) font-medium">
              📁 {folder.name}
            </Link>
          )}
          <button
            onClick={() => setRenaming(true)}
            disabled={renaming}
            title="Rename folder"
            className="text-(--text-faint) hover:text-(--text-secondary) text-xs disabled:opacity-50"
          >
            ✎
          </button>
          <button
            onClick={deleteFolder}
            disabled={deleteMutation.isPending}
            title="Delete folder and everything in it"
            className="text-(--text-faint) hover:text-(--danger-text) text-xs disabled:opacity-50"
            data-testid="delete-folder"
          >
            {deleteMutation.isPending ? "…" : "🗑"}
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
            <ActivityPill label={`${folder.activeBookCount} active`} color="bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)" />
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
      <td className="px-4 py-3"><span className="text-xs text-(--text-faint)">—</span></td>
      <td className="px-4 py-3"><span className="text-xs text-(--text-faint)">—</span></td>
      <td className="px-4 py-3 text-right text-sm tabular-nums text-(--text-tertiary)">
        {formatBytes(folder.sizeBytes)}
      </td>
      <td className="px-4 py-3 text-right text-sm tabular-nums text-(--text-tertiary)">
        {new Date(folder.createdAt).toLocaleDateString()}
      </td>
      <td className="px-4 py-3 text-right text-sm text-(--text-tertiary)" title={folder.lastActivityAt ? new Date(folder.lastActivityAt).toLocaleString() : undefined}>
        {folder.lastActivityAt ? formatRelativeTime(folder.lastActivityAt) : <span className="text-xs text-(--text-faint)">—</span>}
      </td>
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
    <th className={`px-4 py-3 text-${align} text-xs font-medium text-(--text-muted) uppercase tracking-wider`}>
      <button
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-(--text-secondary) ${active ? "text-(--text-secondary)" : ""}`}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <span className={`text-[9px] ${active ? "" : "invisible"}`}>{dir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

export function BookList({ folderId = null }: { folderId?: string | null }) {
  const utils = trpc.useUtils();
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
  const [showMove, setShowMove] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const deleteManyMutation = trpc.books.deleteMany.useMutation({
    onSuccess: () => {
      setSelectedIds(new Set());
      utils.books.list.invalidate();
    },
  });
  const deleteFolderMutation = trpc.folders.delete.useMutation();
  const moveBooksMutation = trpc.books.moveToFolder.useMutation();
  const moveFolderMutation = trpc.folders.move.useMutation();
  const createFolderMutation = trpc.folders.create.useMutation({
    onSuccess: () => {
      setNewFolderName(null);
      utils.books.list.invalidate();
    },
  });

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

  const sorted = sortBooks(books ?? [], sortKey, sortDir);
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
    const titles = [...selectedFolders.map((f) => `📁 "${f.name}"`), ...selectedBooks.map((b) => `"${b.title}"`)]
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

  const th = (label: string, key: SortKey, align?: "left" | "right") => (
    <SortableTh label={label} sortKey={key} align={align} active={sortKey === key} dir={sortDir} onSort={handleSort} />
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setShowDigest(true)}
          disabled={selectedCount < 2}
          title={selectedCount < 2 ? "Select at least 2 books with the checkboxes" : "Create a digest book — one AI summary chapter per selected book, ready to listen to"}
          className="px-3 py-1.5 bg-(--accent) text-(--on-accent) rounded-md text-xs font-medium hover:bg-(--accent-hover) disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="create-digest"
        >
          Create digest ({selectedCount})
        </button>
        <button
          onClick={() => setShowHnDigest(true)}
          title="Build a podcast-style book from a day's top Hacker News stories"
          className="px-3 py-1.5 rounded-md border border-(--border-input) bg-(--bg-card) text-(--text-secondary) text-xs font-medium hover:text-(--text-primary) hover:bg-(--bg-card-hover)"
          data-testid="hn-digest"
        >
          HN digest
        </button>
        <button
          onClick={() => setShowMove(true)}
          disabled={totalSelected === 0}
          title={totalSelected === 0 ? "Select books or folders to move with the checkboxes" : "Move the selection into a folder — or drag rows onto a folder"}
          className="px-3 py-1.5 rounded-md text-xs font-medium border border-(--border) text-(--text-secondary) hover:bg-(--bg-subtle) disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="move-to-folder"
        >
          Move to folder ({totalSelected})
        </button>
        <button
          onClick={deleteSelected}
          disabled={totalSelected === 0 || deleteManyMutation.isPending || deleteFolderMutation.isPending}
          title={totalSelected === 0 ? "Select books or folders to delete with the checkboxes" : "Delete the selection with all its chapters, audio, and files"}
          className="px-3 py-1.5 bg-(--danger) text-(--on-danger) hover:bg-(--danger-hover) rounded-md text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="delete-selected-books"
        >
          {deleteManyMutation.isPending || deleteFolderMutation.isPending ? "Deleting..." : `Delete selected (${totalSelected})`}
        </button>
        {(deleteManyMutation.error || dropError) && (
          <span className="text-sm text-(--danger-text)">{deleteManyMutation.error?.message ?? dropError}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {createFolderMutation.error && (
            <span className="text-sm text-(--danger-text)">{createFolderMutation.error.message}</span>
          )}
          {newFolderName !== null ? (
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={() => { if (!newFolderName.trim()) setNewFolderName(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newFolderName.trim()) {
                  createFolderMutation.mutate({ name: newFolderName.trim(), parentId: folderId });
                }
                if (e.key === "Escape") setNewFolderName(null);
              }}
              placeholder="Folder name…"
              className="px-2 py-1.5 text-xs rounded-md border border-(--border) bg-(--bg-card) text-(--text-primary) outline-none focus:border-(--focus-ring)"
              data-testid="new-folder-name"
            />
          ) : (
            <button
              onClick={() => setNewFolderName("")}
              title="Create a folder here"
              className="px-3 py-1.5 rounded-md text-xs font-medium border border-(--border) text-(--text-secondary) hover:bg-(--bg-subtle)"
              data-testid="new-folder"
            >
              + New folder
            </button>
          )}
        </div>
      </div>
      {isEmpty ? (
        <p className="text-(--text-muted) py-4">
          {folderId ? "This folder is empty." : "No books yet. Upload a PDF to get started."}
        </p>
      ) : (
      <div className="overflow-x-auto rounded-lg border border-(--border)">
      <table className="w-full min-w-[72rem] divide-y divide-(--divide)">
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
            {th("Chapters", "chapters", "right")}
            <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">Activity</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">Languages</th>
            {th("Outputs", "outputs")}
            {th("Size", "size", "right")}
            {th("Created", "created", "right")}
            {th("Last activity", "lastActivity", "right")}
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
                      className="ml-2 text-[10px] text-(--text-faint) align-middle"
                      title="Fully indexed — findable in library chat (keyword + semantic search)"
                      data-testid="index-badge-done"
                    >
                      ✓
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
                      <ActivityPill label="extracting" color="bg-(--badge-extracting-bg) text-(--badge-extracting-text)" />
                    )}
                    {book.activity.synthesizing > 0 && (
                      <ActivityPill label={`synthesizing ${book.activity.synthesizing}`} color="bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)" />
                    )}
                    {book.activity.translating > 0 && (
                      <ActivityPill label={`translating ${book.activity.translating}`} color="bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)" />
                    )}
                    {book.activity.cleaning > 0 && (
                      <ActivityPill label={`cleaning ${book.activity.cleaning}`} color="bg-(--badge-normalizing-bg) text-(--badge-normalizing-text)" />
                    )}
                    {book.activity.assembling && (
                      <ActivityPill label="assembling" color="bg-(--badge-assembling-bg) text-(--badge-assembling-text)" />
                    )}
                    {book.activity.aiNote && (
                      <ActivityPill label="AI note" color="bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)" />
                    )}
                    {book.activity.digest && (
                      <ActivityPill label="digesting" color="bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)" />
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
                <td className="px-4 py-3 text-sm text-(--text-tertiary)">
                  {outputParts.length === 0 ? <span className="text-xs text-(--text-faint)">—</span> : outputParts.join(" · ")}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-(--text-tertiary)">
                  {formatBytes(book.sizeBytes)}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-(--text-tertiary)">
                  {new Date(book.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right text-sm text-(--text-tertiary)" title={new Date(book.lastActivityAt).toLocaleString()}>
                  {formatRelativeTime(book.lastActivityAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      )}

      {showDigest && (
        <DigestModal
          sourceBooks={selectedBooks.map((b) => ({ id: b.id, title: b.title }))}
          folderId={folderId}
          onClose={() => setShowDigest(false)}
        />
      )}
      {showHnDigest && <HnDigestModal onClose={() => setShowHnDigest(false)} />}
      {showMove && (
        <FolderPickerModal
          bookIds={selectedBooks.map((b) => b.id)}
          folderIds={selectedFolders.map((f) => f.id)}
          onClose={() => setShowMove(false)}
          onMoved={() => {
            setShowMove(false);
            clearSelection();
          }}
        />
      )}
    </div>
  );
}
