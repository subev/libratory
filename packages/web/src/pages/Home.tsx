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
import { UploadModal } from "../components/library/UploadModal.tsx";
import { IconChat, IconBook, IconSettings, IconClose, IconUpload } from "../components/icons.tsx";
import type { DragItems } from "../lib/dnd.ts";

export function Home() {
  const utils = trpc.useUtils();
  const { folderId = null } = useParams<{ folderId: string }>();
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const { data: folderPath = [] } = trpc.folders.path.useQuery(
    { id: folderId! },
    { enabled: !!folderId },
  );

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
            onClick={() => setShowUpload(true)}
            title="Drop PDF files or a folder here — folders are scanned recursively for PDFs"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-dashed border-(--border-input) text-xs text-(--text-muted) hover:bg-(--bg-subtle) hover:text-(--text-primary) cursor-pointer"
            data-testid="open-upload"
          >
            <IconUpload className="h-4 w-4" />
            Drop PDFs or <span className="font-semibold text-(--accent-text)">browse…</span>
          </button>
        </div>
      }
      filters={
        <div className="flex items-center gap-2 h-10 px-4 border-b border-(--border)">
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
              placeholder="Search all books…"
              className="w-64 pl-3 pr-8 py-1 text-xs rounded-md border border-(--border-input) bg-(--bg-card) text-(--text-primary) outline-none"
              data-testid="book-search"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                title="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-(--text-faint) hover:text-(--text-secondary) cursor-pointer"
                data-testid="clear-search"
              >
                <IconClose className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex-1" />
          {search.trim() && (
            <span className="text-xs text-(--text-faint)">Searching every book, in every folder</span>
          )}
        </div>
      }
    >
      <div className="p-4">
        {search.trim() ? (
          <BookSearchResults query={search.trim()} />
        ) : (
          <BookList key={folderId ?? "root"} folderId={folderId} />
        )}
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showUpload && (
        <UploadModal
          folderId={folderId}
          onUploaded={(ok) => {
            utils.books.list.invalidate();
            // A failed upload keeps its files staged and its reason on screen; only success is done
            if (ok) setShowUpload(false);
          }}
          onClose={() => setShowUpload(false)}
        />
      )}
    </LibraryShell>
  );
}
