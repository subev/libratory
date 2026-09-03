import { useState } from "react";
import { useParams } from "react-router";
import { trpc } from "../trpc.ts";
import { BookList } from "../components/BookList.tsx";
import { BookSearchResults } from "../components/BookSearchResults.tsx";
import { Breadcrumbs } from "../components/Breadcrumbs.tsx";
import { Button } from "../components/Button.tsx";
import { ProfileSwitcher } from "../components/ProfileSwitcher.tsx";
import { SettingsModal } from "../components/SettingsModal.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { LibraryShell } from "../components/library/LibraryShell.tsx";
import { LibraryFilters } from "../components/library/LibraryFilters.tsx";
import { filterCounts, type LibraryFilter } from "../lib/library-filter.ts";
import { UploadModal } from "../components/library/UploadModal.tsx";
import { IconAdd, IconChat, IconBook, IconSettings, IconUpload } from "../components/icons.tsx";
import type { DragItems, DroppedItems } from "../lib/dnd.ts";

export function Home() {
  const utils = trpc.useUtils();
  const { folderId = null } = useParams<{ folderId: string }>();
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<DroppedItems | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const { data: folderPath = [] } = trpc.folders.path.useQuery(
    { id: folderId! },
    { enabled: !!folderId },
  );
  // The same query BookList runs, so react-query serves both observers from one request — the chips
  // need the unfiltered counts, and the list needs the rows.
  const { data: listData } = trpc.books.list.useQuery({ folderId }, { refetchInterval: 3000 });
  const counts = filterCounts(listData?.books ?? []);
  const createFolderMutation = trpc.folders.create.useMutation({
    onSuccess: () => {
      setNewFolderName(null);
      utils.books.list.invalidate();
    },
  });

  const moveBooksMutation = trpc.books.moveToFolder.useMutation();
  const moveFolderMutation = trpc.folders.move.useMutation();
  async function dropOnCrumb(targetFolderId: string | null, items: DragItems) {
    try {
      if (items.bookIds.length > 0) {
        await moveBooksMutation.mutateAsync({ ids: items.bookIds, folderId: targetFolderId });
      }
      for (const id of items.folderIds.filter((fid) => fid !== targetFolderId)) {
        await moveFolderMutation.mutateAsync({ id, parentId: targetFolderId });
      }
    } finally {
      utils.books.list.invalidate();
      utils.folders.list.invalidate();
    }
  }

  return (
    <LibraryShell
      header={
        <div className="flex items-center gap-2 h-12 px-4 border-b border-(--border) bg-(--bg-card)">
          <h1 className="font-(family-name:--stack-display) text-[17px] font-semibold tracking-tight text-(--text-primary)">
            Libratory
          </h1>
          <ProfileSwitcher />
          <div className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            to={folderId ? `/chat?folderId=${folderId}` : "/chat"}
            title="Chat with the whole library — searches every indexed book and cites pages"
            data-testid="library-chat-link"
          >
            <IconChat className="h-4 w-4" />
            Chat with library
          </Button>
          <Button
            variant="secondary"
            size="sm"
            to="/open"
            title="Open a synced EPUB and read along on its own pages — nothing is uploaded"
            data-testid="open-container-link"
          >
            <IconBook className="h-4 w-4" />
            Open a read-along EPUB
          </Button>
          <ThemeToggle />
          <Button
            variant="icon"
            size="sm"
            onClick={() => setShowSettings(true)}
            title="AI model settings"
            aria-label="AI model settings"
            data-testid="settings-gear"
          >
            <IconSettings className="h-4 w-4" />
          </Button>
        </div>
      }
      bar={
        <div className="flex items-center gap-2 h-11 px-4 border-b border-(--border) bg-(--bg-card)">
          <Breadcrumbs
            onDropItems={dropOnCrumb}
            items={[
              { to: "/", label: "Home", dropFolderId: null },
              ...folderPath.map((f, i) =>
                i === folderPath.length - 1
                  ? { label: f.name }
                  : { to: `/folders/${f.id}`, label: f.name, dropFolderId: f.id },
              ),
            ]}
          />
          <div className="flex-1" />
          {/* button-ok: a dashed edge is the affordance — it reads as the drop target the page used
              to have in full, which no Button variant expresses. */}
          <button
            onClick={() => { setDroppedFiles(null); setShowUpload(true); }}
            title="Drop PDF files or a folder anywhere in the library — folders are scanned recursively for PDFs"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-dashed border-(--border-input) text-xs text-(--text-muted) hover:bg-(--bg-subtle) hover:text-(--text-primary) cursor-pointer"
            data-testid="open-upload"
          >
            <IconUpload className="h-4 w-4" />
            Drop PDFs or <span className="font-semibold text-(--accent-text)">browse…</span>
          </button>
          {createFolderMutation.error && (
            <span className="text-xs text-(--danger-text)">{createFolderMutation.error.message}</span>
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
              className="px-2 py-1 text-xs rounded-md border border-(--border-input) bg-(--bg-card) text-(--text-primary) outline-none"
              data-testid="new-folder-name"
            />
          ) : (
            <Button size="sm" onClick={() => setNewFolderName("")} title="Create a folder here" data-testid="new-folder">
              <IconAdd className="h-3 w-3" />
              New folder
            </Button>
          )}
        </div>
      }
      filters={
        <LibraryFilters
          filter={filter}
          onFilter={setFilter}
          counts={counts}
          search={search}
          onSearch={setSearch}
          showing={counts[filter] === counts.all ? null : `Showing ${counts[filter]} of ${counts.all}`}
        />
      }
      onFilesDropped={(drop) => {
        setDroppedFiles(drop);
        setShowUpload(true);
      }}
    >
      {search.trim() ? (
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">
          <BookSearchResults query={search.trim()} />
        </div>
      ) : (
        <BookList
          key={folderId ?? "root"}
          folderId={folderId}
          filter={filter}
          onClearFilter={() => setFilter("all")}
          onAddBooks={() => { setDroppedFiles(null); setShowUpload(true); }}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showUpload && (
        <UploadModal
          folderId={folderId}
          initialDrop={droppedFiles}
          onUploaded={(ok) => {
            utils.books.list.invalidate();
            // A failed upload keeps its files staged and its reason on screen; only success is done
            if (ok) { setShowUpload(false); setDroppedFiles(null); }
          }}
          onClose={() => { setShowUpload(false); setDroppedFiles(null); }}
        />
      )}
    </LibraryShell>
  );
}
