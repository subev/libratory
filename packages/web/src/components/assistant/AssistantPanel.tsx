import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { StoredChatMessage } from "../../../../server/src/lib/chats.ts";
import { trpc } from "../../trpc.ts";
import { useProfileId } from "../../lib/use-profile-id.ts";
import { nextStep } from "../../lib/assistant-next-step.ts";
import { panelShownOn, screenOf, type Screen } from "../../lib/assistant-screen.ts";
import { indexState } from "../../lib/search-index-state.ts";
import { clampPanelWidth, clearThread, loadPanelWidth, loadThread, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, savePanelWidth, saveThread } from "../../lib/assistant-prefs.ts";
import { Button } from "../Button.tsx";
import { Modal, ModalHeader } from "../Modal.tsx";
import { PillToggle } from "../PillToggle.tsx";
import { ChatSidebar } from "../chat/ChatSidebar.tsx";
import { draftFromScope, draftReady, flattenFolders, SourcePicker, type DraftScope, type FolderOption } from "../chat/SourcePicker.tsx";
import { askable, NO_FILTER, type HistoryFilter } from "../../lib/chat-history.ts";
import { SavedAnswersModal } from "../chat/SavedAnswers.tsx";
import { IconAi, IconBooks, IconHistory, IconNewChat, IconSidebar } from "../icons.tsx";
import { useAssistant } from "./context.tsx";
import { AssistantSetup } from "./AssistantSetup.tsx";
import { ModelBundleNotice } from "../ModelBundleNotice.tsx";
import { AssistantThread } from "./AssistantThread.tsx";

// Where the panel sits beside the page. Open it is 392px unless dragged wider or narrower,
// collapsed a 48px rail; the page beside it measures its own width, so the book page steps down
// its layout on its own as the panel changes.
const RAIL_WIDTH = "w-12";

// The keyboard's step on the handle, in px
const KEY_STEP = 16;

// Dragging the panel's left edge. The width lives in state while the pointer moves and is saved
// when it lets go; the page beside the panel re-measures itself on every step.
function useResizableWidth() {
  const [width, setWidth] = useState(loadPanelWidth);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = { startX: e.clientX, startWidth: width };
  }, [width]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (!drag) return;
    // The handle is on the left edge: moving the pointer left widens the panel
    setWidth(clampPanelWidth(drag.startWidth + (drag.startX - e.clientX), window.innerWidth));
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setWidth((w) => {
      savePanelWidth(w);
      return w;
    });
  }, []);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
    if (delta === 0) return;
    e.preventDefault();
    setWidth((w) => {
      const next = clampPanelWidth(w + delta, window.innerWidth);
      savePanelWidth(next);
      return next;
    });
  }, []);

  // A window that shrinks under a wide panel pulls it back within half the window
  useEffect(() => {
    const onResize = () => setWidth((w) => clampPanelWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, handle: { onPointerDown, onPointerMove, onPointerUp, onKeyDown } };
}

// What a new thread will search: the page it is opened beside, or sources chosen the way the
// library chat chooses them. A thread's scope is fixed by its first question, as in the chat.
export type SourcesChoice = { kind: "screen" } | DraftScope;

export function scopeInputOf(choice: SourcesChoice): { kind: "screen" } | { kind: "library" } | { kind: "folder"; folderId: string } | { kind: "books"; bookIds: string[] } {
  switch (choice.kind) {
    case "screen":
      return { kind: "screen" };
    case "library":
      return { kind: "library" };
    case "folder":
      return { kind: "folder", folderId: choice.folderId };
    case "books":
      return { kind: "books", bookIds: choice.bookIds };
    default: {
      const unhandled: never = choice;
      throw new Error(`unhandled sources ${JSON.stringify(unhandled)}`);
    }
  }
}

// The chip names what a question would search right now, never the rule: a thread that follows
// the page reads as the book on screen, or as the whole library off one
function choiceLabel(choice: SourcesChoice, books: { id: string; title: string }[], folders: FolderOption[], screenBook: string | null): string {
  switch (choice.kind) {
    case "screen":
      return screenBook ?? "Whole library";
    case "library":
      return "Whole library";
    case "folder":
      return folders.find((f) => f.id === choice.folderId)?.name ?? "Folder";
    case "books": {
      const [first] = choice.bookIds;
      const title = books.find((b) => b.id === first)?.title ?? "Book";
      return choice.bookIds.length === 1 ? title : `${choice.bookIds.length} books`;
    }
    default: {
      const unhandled: never = choice;
      throw new Error(`unhandled sources ${JSON.stringify(unhandled)}`);
    }
  }
}

// The chat's source picker, with "this page" in front of it
function SourcesModal({ value, onPick, onClose }: { value: SourcesChoice; onPick: (choice: SourcesChoice) => void; onClose: () => void }) {
  const [choice, setChoice] = useState<SourcesChoice>(value);
  const { data: bookOptions = [] } = trpc.chats.bookOptions.useQuery();
  const { data: folders = [] } = trpc.folders.list.useQuery();
  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);
  const ready = choice.kind === "screen" || draftReady(choice);
  return (
    <Modal size="md" onClose={onClose} backdropTestId="assistant-sources-modal">
      <ModalHeader title="What the assistant searches" onClose={onClose} />
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <PillToggle selected={choice.kind === "screen"} onClick={() => setChoice({ kind: "screen" })} testId="assistant-sources-screen">Follow the page</PillToggle>
          <PillToggle selected={choice.kind !== "screen"} onClick={() => setChoice({ kind: "library" })} testId="assistant-sources-choose">Choose sources</PillToggle>
        </div>
        <p className="text-xs text-(--text-muted)">
          {choice.kind === "screen"
            ? "Searches the book you are on, and the whole library elsewhere. Actions always work on what is on screen."
            : "Fixed for the thread once the first question is asked, like a library chat."}
        </p>
        {choice.kind !== "screen" && (
          <SourcePicker draft={choice} onChange={setChoice} folders={folderOptions} books={bookOptions} libraryNote="Every book, originals and translations." />
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-(--border) p-3">
        <Button size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={!ready} onClick={() => { onPick(choice); onClose(); }} data-testid="assistant-sources-use">Use these</Button>
      </div>
    </Modal>
  );
}

// The chat's history sidebar, in a dialog: search by question, filter by book, rename, delete
function HistoryModal({ activeId, onOpen, onNew, onShowSaved, onClose }: { activeId: string | null; onOpen: (id: string) => void; onNew: () => void; onShowSaved: () => void; onClose: () => void }) {
  const { data: conversations = [] } = trpc.chats.list.useQuery();
  const { data: savedAnswers = [] } = trpc.notes.listLibrary.useQuery();
  const [filter, setFilter] = useState<HistoryFilter>(NO_FILTER);
  return (
    <Modal size="md" onClose={onClose} backdropTestId="assistant-history-modal">
      <div className="flex max-h-[80vh] min-h-96 flex-col">
        <ChatSidebar
          conversations={conversations}
          activeId={activeId}
          filter={filter}
          onFilter={setFilter}
          onNewChat={() => { onNew(); onClose(); }}
          onNavigate={onClose}
          onOpen={onOpen}
          onClose={onClose}
          savedAnswers={savedAnswers.length}
          onShowSaved={() => { onShowSaved(); onClose(); }}
          onDeleted={(id) => { if (id === activeId) onNew(); }}
        />
      </div>
    </Modal>
  );
}

export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const location = useLocation();
  const profileId = useProfileId();
  if (!panelShownOn(location.pathname)) return null;
  const screen = screenOf(location.pathname);

  if (!open) {
    return (
      <aside className={`${RAIL_WIDTH} flex shrink-0 flex-col items-center gap-2 border-l border-(--border) bg-(--bg-card) py-2`} data-testid="assistant-rail">
        <Button variant="icon" size="sm" onClick={() => setOpen(true)} aria-label="Open the assistant" title="Assistant"><IconAi className="h-5 w-5" /></Button>
        {screen.bookId && <RailTip bookId={screen.bookId} onOpen={() => setOpen(true)} />}
      </aside>
    );
  }
  // Keyed by profile: a thread belongs to one, so a switch remounts the panel on that profile's
  // own last thread instead of sending the next question to a conversation the server now refuses
  return <OpenPanel key={profileId} profileId={profileId} screen={screen} onCollapse={() => setOpen(false)} />;
}

function OpenPanel({ profileId, screen, onCollapse }: { profileId: string; screen: Screen; onCollapse: () => void }) {
  // Undecided until the list has arrived: judging "no model" from an empty list still loading
  // drew the setup tiles for a frame on every refresh
  const { data: models, isPending: modelsPending } = trpc.llmModels.list.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const connected = (models ?? []).some((m) => m.supportsTools);
  // Which thread is on screen. The key changes when another is opened or a new one started, so
  // the thread remounts and seeds itself again. One born in the panel keeps its key and is never
  // fetched: its first answer is still streaming when it gets its id, and a fetch that flipped
  // the panel to "loading" would unmount the stream.
  const [thread, setThread] = useState<{ id: string | null; key: number; born: boolean }>(() => ({ id: loadThread(profileId)?.id ?? null, key: 0, born: false }));
  const [sources, setSources] = useState<SourcesChoice>({ kind: "screen" });
  const [showSaved, setShowSaved] = useState(false);
  const [picking, setPicking] = useState(false);
  const [history, setHistory] = useState(false);
  const { data: bookOptions = [] } = trpc.chats.bookOptions.useQuery(undefined, { enabled: sources.kind === "books" });
  const { data: screenBook } = trpc.books.get.useQuery({ id: screen.bookId ?? "" }, { enabled: !!screen.bookId });
  const screenLabel = screen.bookId ? (screenBook?.title ?? "This book") : null;
  // Whether a search of the book on screen can find anything yet: the dot the chat link carried
  const index = screenBook ? indexState(screenBook.searchIndex, screenBook.chapters.length > 0) : null;
  const { data: folderRows = [] } = trpc.folders.list.useQuery(undefined, { enabled: sources.kind === "folder" });
  const folderOptions = useMemo(() => flattenFolders(folderRows), [folderRows]);
  const { width, handle } = useResizableWidth();
  const { data: opened, isPending } = trpc.chats.get.useQuery(
    // Disabled without an id, so the placeholder is never sent
    { id: thread.id ?? "" },
    {
      enabled: !!thread.id && !thread.born,
      gcTime: 0,
      staleTime: Infinity,
      // An answer being written by a run this window did not start — the tab that asked was
      // closed, or is open elsewhere. The server carries on regardless; this follows it.
      refetchInterval: (query) => (query.state.data?.running ? 1000 : false),
    },
  );
  const watching = !!opened?.running;

  const fetched = !!thread.id && !thread.born;
  // A stored thread that is gone starts afresh
  const stale = fetched && !isPending && !opened;
  const loading = fetched && isPending;
  // Read, not continued, once everything it searched is gone; the next thread is never widened for it
  const closed = opened && !stale && !askable(opened.scope).canAsk
    ? (opened.scope.kind === "folder" ? "That folder is gone. Start a new chat." : "The books this thread searched are gone. Start a new chat.")
    : null;

  // What the thread on screen searches: the opened thread's own scope, else the choice made for
  // the next one. One value, so the label, the picker and a new thread never disagree.
  const current: SourcesChoice = opened && !stale && thread.id
    ? (opened.scope.kind === "screen" ? { kind: "screen" } : draftFromScope(opened.scope))
    : sources;
  // A new thread starts on the sources given, else on what the thread it leaves searched (minus
  // what is gone); one that followed the page keeps following it
  const newThread = (next: SourcesChoice = current) => {
    setSources(next);
    clearThread(profileId);
    setThread((t) => ({ id: null, key: t.key + 1, born: false }));
  };
  const openThread = (id: string) => {
    saveThread(profileId, id);
    setThread((t) => ({ id, key: t.key + 1, born: false }));
  };
  // A thread already asked keeps the sources it was asked with; a new one takes the choice
  const newThreadWith = (choice: SourcesChoice) => {
    if (thread.id) newThread(choice);
    else setSources(choice);
  };
  const sourcesLabel = choiceLabel(current, bookOptions, folderOptions, screenLabel);
  const followingScreen = current.kind === "screen";

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-(--border) bg-(--bg-page)" style={{ width }} data-testid="assistant-panel">
      {/* The left edge is the handle: a thin strip that widens on hover, draggable and focusable */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the assistant"
        aria-valuenow={width}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        tabIndex={0}
        {...handle}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-(--accent-subtle) focus-visible:bg-(--accent-subtle)"
        data-testid="assistant-resize"
      />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--border) bg-(--bg-card) px-3">
        <h2 className="font-(family-name:--stack-display) text-[17px] font-semibold tracking-tight text-(--text-primary)">Assistant</h2>
        <div className="flex-1" />
        {connected && (
          <Button size="sm" onClick={() => setPicking(true)} title={index && followingScreen ? `What this thread searches · ${index.hint}` : "What this thread searches"} data-testid="assistant-sources">
            <IconBooks className="h-3.5 w-3.5" />
            <span className="max-w-44 truncate" data-testid="assistant-sources-label">{sourcesLabel}</span>
            {index && followingScreen && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${index.dot} ${index.pulse ? "animate-pulse" : ""}`} data-testid="assistant-index-dot" />}
          </Button>
        )}
        {connected && <Button variant="icon" size="sm" onClick={() => setHistory(true)} aria-label="Past assistant chats" title="Past assistant chats" data-testid="chat-history-open"><IconHistory className="h-4 w-4" /></Button>}
        {connected && <Button variant="icon" size="sm" onClick={() => newThread()} aria-label="New chat" title="New chat"><IconNewChat className="h-4 w-4" /></Button>}
        <Button variant="icon" size="sm" onClick={onCollapse} aria-label="Collapse the assistant" title="Collapse"><IconSidebar className="h-4 w-4" /></Button>
      </div>
      {modelsPending ? (
        <div className="flex-1" />
      ) : !connected ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <AssistantSetup onConnected={() => {}} />
        </div>
      ) : loading ? (
        <div className="flex-1" />
      ) : (
        <>
          {/* The chat page was the doorway for the search embeddings; this is where the search lives now */}
          <div className="shrink-0 px-3 pt-3 empty:hidden"><ModelBundleNotice id="search" verb="Searching and asking across the library" /></div>
          <AssistantThread
            // Not the id: a thread born here gains one mid-answer, and a key that changed with it
            // would remount the thread and drop the answer it was streaming
            // ...and remounted when a watched answer ends, so it is seeded again from what was kept
            key={`${thread.key}:${stale ? "fresh" : watching ? "watching" : "thread"}`}
            open={!stale && opened ? { id: opened.id, messages: opened.messages as StoredChatMessage[], removedBookIds: opened.removedBookIds, closed } : null}
            watching={watching}
            profileId={profileId}
            scope={scopeInputOf(sources)}
            onCreated={(id) => setThread((t) => ({ ...t, id, born: true }))}
          />
        </>
      )}
      {picking && <SourcesModal value={current} onPick={newThreadWith} onClose={() => setPicking(false)} />}
      {history && <HistoryModal activeId={thread.id} onOpen={openThread} onNew={newThread} onShowSaved={() => setShowSaved(true)} onClose={() => setHistory(false)} />}
      {showSaved && <SavedAnswersModal onClose={() => setShowSaved(false)} />}
    </aside>
  );
}

// The collapsed rail's one word: a step is still to be taken on this book
function RailTip({ bookId, onOpen }: { bookId: string; onOpen: () => void }) {
  // Polled only while the book is working; once a step is owed, it stays owed until someone acts
  const { data: book } = trpc.books.get.useQuery({ id: bookId }, { refetchInterval: (q) => (q.state.data && nextStep(q.state.data).action === null ? 5000 : false) });
  if (!book) return null;
  const step = nextStep(book);
  if (!step.action) return null;
  return (
    // button-ok: a one-word badge that opens the panel, not an action of its own
    <button type="button" onClick={onOpen} title={`${step.title} — open the assistant`} className="rounded-full bg-(--accent-subtle) px-1.5 text-[10px] font-semibold text-(--accent-text)" data-testid="assistant-rail-tip">
      1 tip
    </button>
  );
}

// The toolbar button every page shows: the one way in besides the rail
export function AssistantToggle() {
  const { open, toggle } = useAssistant();
  const location = useLocation();
  if (!panelShownOn(location.pathname)) return null;
  return (
    <Button variant="secondary" size="sm" onClick={toggle} aria-pressed={open} title={open ? "Collapse the assistant" : "Open the assistant"} data-testid="assistant-toggle">
      <IconAi className="h-4 w-4" weight={open ? "fill" : "regular"} />
      Assistant
    </Button>
  );
}
