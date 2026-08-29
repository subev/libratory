import { useState } from "react";
import { Link, useParams } from "react-router";
import { trpc } from "../trpc.ts";
import { UploadZone } from "../components/UploadZone.tsx";
import { BookList } from "../components/BookList.tsx";
import { BookSearchResults } from "../components/BookSearchResults.tsx";
import { Breadcrumbs } from "../components/Breadcrumbs.tsx";
import { ProfileSwitcher } from "../components/ProfileSwitcher.tsx";
import { SettingsModal } from "../components/SettingsModal.tsx";
import type { DragItems } from "../lib/dnd.ts";

export function Home() {
  const utils = trpc.useUtils();
  const { folderId = null } = useParams<{ folderId: string }>();
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const { data: folderPath = [] } = trpc.folders.path.useQuery(
    { id: folderId! },
    { enabled: !!folderId },
  );
  const currentFolder = folderPath.at(-1);

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
    <div className="min-h-screen bg-(--bg-page)">
      <div className="max-w-screen-2xl mx-auto px-6 py-8">
        <div className="flex items-center mb-2">
          <h1 className="text-2xl font-bold text-(--text-primary)">Libratory</h1>
          <ProfileSwitcher />
          <Link
            to={folderId ? `/chat?folderId=${folderId}` : "/chat"}
            className="ml-auto text-sm px-3 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-card-hover)"
            data-testid="library-chat-link"
          >
            💬 Chat with library
          </Link>
          <Link
            to="/open"
            title="Open a synced EPUB and read along on its own pages — nothing is uploaded"
            className="ml-2 text-sm px-3 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-card-hover)"
            data-testid="open-container-link"
          >
            📖 Open a read-along EPUB
          </Link>
          <button
            onClick={() => setShowSettings(true)}
            title="AI model settings"
            data-testid="settings-gear"
            className="text-sm px-2.5 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-card-hover)"
          >
            ⚙️
          </button>
        </div>
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        {folderId && (
          <div className="mb-4">
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
          </div>
        )}

        <section className="mb-8 mt-4">
          <UploadZone folderId={folderId} onUploadComplete={() => utils.books.list.invalidate()} />
        </section>

        <section>
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-lg font-semibold text-(--text-secondary)">
              {currentFolder ? `📁 ${currentFolder.name}` : "Books"}
            </h2>
            <div className="ml-auto relative">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
                placeholder="Search all books…"
                className="w-72 pl-3 pr-8 py-1.5 text-sm rounded-md border border-(--border) bg-(--bg-card) text-(--text-primary) outline-none"
                data-testid="book-search"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  title="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-(--text-faint) hover:text-(--text-secondary)"
                  data-testid="clear-search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          {search.trim() ? (
            <BookSearchResults query={search.trim()} />
          ) : (
            <BookList key={folderId ?? "root"} folderId={folderId} />
          )}
        </section>
      </div>
    </div>
  );
}
