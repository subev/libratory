import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { trpc } from "../trpc.ts";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { Button } from "../components/Button.tsx";
import { ChatSidebar } from "../components/chat/ChatSidebar.tsx";
import { ConversationPane } from "../components/chat/ConversationPane.tsx";
import { SavedAnswersModal } from "../components/chat/SavedAnswers.tsx";
import { draftFromScope, type DraftScope, type FolderOption } from "../components/chat/SourcePicker.tsx";
import { NO_FILTER, type ConversationScope, type HistoryFilter } from "../lib/chat-history.ts";
import { IconArrowLeft, IconSidebar } from "../components/icons.tsx";

function flattenFolders(folders: { id: string; name: string; parentId: string | null }[]): FolderOption[] {
  const byParent = new Map<string | null, typeof folders>();
  for (const f of folders) {
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  const out: FolderOption[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of byParent.get(parentId) ?? []) {
      out.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// One-time cleanup of transcripts left behind by the retired localStorage persistence
for (const key of Object.keys(localStorage)) {
  if (key.startsWith("library-chat.messages.")) localStorage.removeItem(key);
}

// A viewport shell: the bar, the history and the composer are pinned, and the history and the
// conversation each scroll on their own. Nothing here needs a scroll to the top to be reached.
export function Chat() {
  const { conversationId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const bookId = searchParams.get("bookId") ?? undefined;
  const folderId = searchParams.get("folderId") ?? undefined;

  const { data: scopedBook } = trpc.books.get.useQuery({ id: bookId! }, { enabled: !!bookId });
  const { data: folders = [] } = trpc.folders.list.useQuery();
  const { data: indexStatus } = trpc.search.indexStatus.useQuery();
  const { data: conversations = [] } = trpc.chats.list.useQuery();
  const { data: savedAnswers = [] } = trpc.notes.listLibrary.useQuery();
  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);

  // Arriving from a book shows that book's conversations; it is only where the filter starts
  const [filter, setFilter] = useState<HistoryFilter>(() => (bookId ? { ...NO_FILTER, bookId } : NO_FILTER));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showSaved, setShowSaved] = useState(false);

  // The pane is keyed so that opening another conversation starts it afresh. The one exception is
  // a new chat's first question: it gains an id and a URL mid-answer, and remounting there would
  // drop the stream — so a conversation born in this pane keeps the pane's key.
  const [newChats, setNewChats] = useState(0);
  const [born, setBorn] = useState<{ id: string; key: string } | null>(null);
  // Only while that pane is still the one on screen: once another conversation has been opened the
  // born one is a stored conversation like any other, and must be loaded like one
  if (born && conversationId !== born.id && !(conversationId === undefined && `new-${newChats}` === born.key)) setBorn(null);
  const bornHere = !!conversationId && born?.id === conversationId;
  const paneKey = conversationId ? (bornHere ? born.key : conversationId) : `new-${newChats}`;

  // Read once per opening, never from cache: the pane seeds its transcript from this and then owns it
  const opened = trpc.chats.get.useQuery(
    { id: conversationId! },
    {
      enabled: !!conversationId && !bornHere,
      gcTime: 0,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      // An answer being written by a run this window did not start — the tab that asked was
      // closed, or it is open elsewhere. The server carries on regardless; this follows it.
      refetchInterval: (query) => (query.state.data?.running ? 1000 : false),
    },
  );
  const watching = !!opened.data?.running;

  const [modelByPane, setModelByPane] = useState<Record<string, string>>({});
  const model = modelByPane[paneKey] ?? opened.data?.model ?? "";

  // A new chat opened from a conversation starts on that conversation's sources
  const [carried, setCarried] = useState<DraftScope | null>(null);
  const newChat = (from?: ConversationScope) => {
    const current = from ?? opened.data?.scope ?? conversations.find((c) => c.id === conversationId)?.scope;
    setCarried(current ? draftFromScope(current) : null);
    setDrawerOpen(false);
    setNewChats((n) => n + 1);
    void navigate(bookId ? `/chat?bookId=${bookId}` : "/chat");
  };

  const notIndexed = indexStatus ? indexStatus.total - indexStatus.done : 0;
  const libraryNote = [
    "Every book, originals and translations.",
    notIndexed > 0 ? `${notIndexed} ${notIndexed === 1 ? "is" : "are"} not fully indexed yet — answers may miss ${notIndexed === 1 ? "it" : "them"}.` : "",
    indexStatus && indexStatus.running > 0 ? `Indexing ${indexStatus.running} now…` : "",
  ].filter(Boolean).join(" ");

  const relatedCount = bookId
    ? conversations.filter((c) => c.scope.kind === "books" && c.scope.books.some((book) => book.id === bookId)).length
    : 0;
  const activeTitle = conversations.find((c) => c.id === conversationId)?.title;
  const loading = !!conversationId && !bornHere && opened.isPending;
  const missing = !!conversationId && !bornHere && !opened.isPending && !opened.data;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-(--bg-page) text-(--text-primary)">
      <div className="flex h-12 flex-none items-center gap-2 border-b border-(--border) bg-(--bg-card) px-2 md:gap-3 md:px-4" data-testid="chat-toolbar">
        {/* The labelled link below is hidden under md; a chat opened by its URL needs a way out that is not the browser's */}
        <Button variant="icon" to={bookId ? `/books/${bookId}` : "/"} aria-label={bookId ? "Back to the book" : "Back to the library"} className="md:hidden" data-testid="chat-back-compact">
          <IconArrowLeft className="h-5 w-5" />
        </Button>
        <Button variant="icon" onClick={() => setDrawerOpen(true)} aria-label="Conversations" className="md:hidden" data-testid="chat-history-open">
          <IconSidebar className="h-5 w-5" />
        </Button>
        <Link
          to={bookId ? `/books/${bookId}` : "/"}
          className="hidden max-w-64 items-center gap-1 text-sm text-(--text-muted) hover:text-(--text-secondary) md:inline-flex"
          title={bookId ? `Back to ${scopedBook?.title ?? "the book"}` : "Back to the library"}
          data-testid="chat-back"
        >
          <IconArrowLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">{bookId ? (scopedBook?.title ?? "Back") : "Library"}</span>
        </Link>
        <div className="hidden h-5 w-px bg-(--border) md:block" />
        <h1 className="min-w-0 flex-1 truncate text-base font-bold text-(--text-primary)">
          <span className="md:hidden">{activeTitle ?? "Library chat"}</span>
          <span className="hidden md:inline">Library chat</span>
        </h1>
        <div className="flex flex-none items-center gap-2">
          <ModelPicker value={model} onChange={(key) => setModelByPane((prev) => ({ ...prev, [paneKey]: key }))} requireTools testId="chat-model" />
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {drawerOpen && <div className="absolute inset-0 z-30 bg-(--scrim) md:hidden" onClick={() => setDrawerOpen(false)} />}
        <aside
          className={`${drawerOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-40 w-80 max-w-[85vw] flex-col border-r border-(--border) bg-(--bg-card) shadow-xl md:static md:z-auto md:flex md:w-72 md:flex-none md:shadow-none`}
          data-testid="chat-sidebar"
        >
          <ChatSidebar
            conversations={conversations}
            activeId={conversationId ?? null}
            filter={filter}
            onFilter={setFilter}
            onNewChat={() => newChat()}
            onNavigate={() => setDrawerOpen(false)}
            onClose={() => setDrawerOpen(false)}
            savedAnswers={savedAnswers.length}
            onShowSaved={() => setShowSaved(true)}
            onDeleted={(id) => {
              if (id === conversationId) newChat();
            }}
          />
        </aside>

        {loading && <main className="flex-1" />}
        {missing && (
          <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-(--text-muted)" data-testid="chat-missing">
            <p>This conversation is not here any more.</p>
            <Button variant="primary" size="sm" onClick={() => newChat()}>New chat</Button>
          </main>
        )}
        {!loading && !missing && (
          <ConversationPane
            // Remounted when a watched answer ends, so the pane is seeded again from what was kept
            key={`${paneKey}:${watching ? "watching" : "own"}`}
            open={opened.data ?? null}
            preset={{ bookId, folderId, draft: carried ?? undefined }}
            relatedCount={relatedCount}
            model={model}
            folders={folderOptions}
            libraryNote={libraryNote}
            onCreated={(id) => {
              setBorn({ id, key: paneKey });
              void navigate(`/chat/${id}`, { replace: true });
            }}
            onNewChat={newChat}
          />
        )}
      </div>

      {showSaved && <SavedAnswersModal onClose={() => setShowSaved(false)} />}
    </div>
  );
}
