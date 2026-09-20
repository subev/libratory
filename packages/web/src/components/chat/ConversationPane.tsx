import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { StoredChatMessage, WireChatMessage } from "../../../../server/src/lib/chats.ts";
import { trpc } from "../../trpc.ts";
import { profileHeaders } from "../../lib/profile.ts";
import { askable, type ConversationScope } from "../../lib/chat-history.ts";
import { Button } from "../Button.tsx";
import { Menu } from "../Menu.tsx";
import { ModelBundleNotice } from "../ModelBundleNotice.tsx";
import { PdfPreviewModal } from "../PdfPreviewModal.tsx";
import { IconAdd, IconBlocked, IconBook, IconBookRemoved, IconBooks, IconFolder, IconRerun } from "../icons.tsx";
import { ChatMessage, messageText, type AnswerRetry, type AnswerStatus } from "./ChatMessage.tsx";
import { draftReady, SourcePicker, type BookOption, type DraftScope, type FolderOption } from "./SourcePicker.tsx";

// How close to the bottom still counts as reading the newest line
const FOLLOW_WITHIN_PX = 80;

// Past two, the header names the first and counts the rest
const MAX_CHIPS = 2;

export type OpenConversation = {
  id: string;
  scope: ConversationScope;
  messages: WireChatMessage[];
  // Books the transcript cites or chose that are gone — known for every scope, not only chosen books
  removedBookIds: string[];
  // Being answered by a run this window did not start. The pane then shows what the server
  // reports, poll by poll, instead of a stream of its own.
  running: boolean;
};

// `draft` is sources carried over from the conversation New chat was pressed in; it outranks the URL
export type NewChatPreset = { bookId?: string; folderId?: string; draft?: DraftScope };

function errorText(error: Error | undefined): string | null {
  if (!error) return null;
  try {
    const parsed: unknown = JSON.parse(error.message);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not a JSON body — the message is already the text
  }
  return error.message;
}

function draftAsScope(draft: DraftScope, books: BookOption[], folders: FolderOption[]): ConversationScope {
  switch (draft.kind) {
    case "library":
      return { kind: "library" };
    case "folder":
      return { kind: "folder", folderId: draft.folderId, name: folders.find((folder) => folder.id === draft.folderId)?.name ?? "Folder", available: true };
    case "books":
      return {
        kind: "books",
        books: draft.bookIds.map((id) => ({ id, title: books.find((book) => book.id === id)?.title ?? "…", available: true })),
      };
    default: {
      const unhandled: never = draft;
      throw new Error(`unhandled draft scope ${JSON.stringify(unhandled)}`);
    }
  }
}

function Chip({ icon, children, title, tone = "solid" }: { icon: React.ReactNode; children: React.ReactNode; title?: string; tone?: "solid" | "removed" }) {
  return (
    <span
      title={title}
      className={`inline-flex h-6 min-w-0 max-w-72 items-center gap-1.5 rounded-md border bg-(--bg-card) px-2 text-xs ${
        tone === "removed" ? "border-dashed border-(--border-input) text-(--text-muted)" : "border-(--border) text-(--text-primary)"
      }`}
      data-testid="chat-source-chip"
    >
      <span className="shrink-0">{icon}</span>
      {children}
    </span>
  );
}

const REMOVED_BADGE = <span className="shrink-0 rounded-full bg-(--warning-bg) px-1.5 text-[10px] font-semibold text-(--warning-text)">removed</span>;

// What this chat searches. Chips in the conversation's own header, so they never read as the
// sidebar's filters, which are form fields in the sidebar.
function ScopeChips({ scope, fixed }: { scope: ConversationScope; fixed: boolean }) {
  switch (scope.kind) {
    case "library":
      return <Chip icon={<IconBooks className="h-3 w-3" />}>Whole library</Chip>;
    case "folder":
      return scope.available ? (
        <Chip icon={<IconFolder className="h-3 w-3" />} title={scope.name}><span className="truncate">{scope.name}</span></Chip>
      ) : (
        <Chip icon={<IconFolder className="h-3 w-3" />} tone="removed" title={`${scope.name} — removed`}>
          <span className="truncate line-through">{scope.name}</span>
          {REMOVED_BADGE}
        </Chip>
      );
    case "books": {
      const present = scope.books.filter((book) => book.available);
      const removed = scope.books.filter((book) => !book.available);
      // With nothing left, the removed books are all there is to show
      const chips = present.length > 0 ? present : removed;
      const head = chips.length > MAX_CHIPS ? chips.slice(0, 1) : chips;
      const more = chips.length - head.length;
      return (
        <>
          {head.map((book) => (
            <Chip
              key={book.id}
              icon={book.available ? <IconBook className="h-3 w-3" /> : <IconBookRemoved className="h-3 w-3" />}
              tone={book.available ? "solid" : "removed"}
              title={book.available ? book.title : `${book.title} — removed`}
            >
              <span className={`truncate ${book.available ? "" : "line-through"}`}>{book.title}</span>
              {!book.available && REMOVED_BADGE}
            </Chip>
          ))}
          {more > 0 && (
            <Menu
              testId="chat-sources-more"
              width="w-96"
              trigger={({ toggle }) => (
                <Button variant="secondary" size="sm" onClick={toggle} title="Every book this chat searches">+{more} more</Button>
              )}
            >
              {() => (
                <div className="p-1">
                  <p className="px-2 pt-1 pb-2 text-xs text-(--text-muted)">
                    This conversation searches {scope.books.length} books.{fixed ? " Fixed since the first question." : ""}
                  </p>
                  {scope.books.map((book) => (
                    <div key={book.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-(--bg-card-hover)">
                      {book.available ? <IconBook className="h-4 w-4 shrink-0 text-(--text-faint)" /> : <IconBookRemoved className="h-4 w-4 shrink-0 text-(--text-faint)" />}
                      <span title={book.title} className={`min-w-0 flex-1 truncate text-xs ${book.available ? "text-(--text-primary)" : "text-(--text-muted) line-through"}`}>{book.title}</span>
                      {book.available
                        ? <Button variant="primary" soft size="sm" to={`/books/${book.id}`}>Open</Button>
                        : REMOVED_BADGE}
                    </div>
                  ))}
                </div>
              )}
            </Menu>
          )}
          {present.length > 0 && removed.length > 0 && (
            <Chip icon={<IconBookRemoved className="h-3 w-3" />} tone="removed" title={removed.map((book) => `${book.title} — removed`).join("\n")}>
              {removed.length} removed
            </Chip>
          )}
        </>
      );
    }
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}

function RemovedNotice({ scope }: { scope: ConversationScope }) {
  const { canAsk, remaining, removed } = askable(scope);
  if (scope.kind === "folder" && !scope.available) {
    return <Notice><b className="font-semibold text-(--text-secondary)">{scope.name}</b> was removed from the library. The conversation is kept as it was.</Notice>;
  }
  if (removed.length === 0) return null;
  const names = removed.map((book) => book.title).join(", ");
  return (
    <Notice>
      <b className="font-semibold text-(--text-secondary)">{names}</b> {removed.length === 1 ? "was" : "were"} removed from the library. The conversation is kept
      as it was; passage links into {removed.length === 1 ? "it" : "them"} no longer open.
      {canAsk && ` From here on, answers search the ${remaining} remaining book${remaining === 1 ? "" : "s"}.`}
    </Notice>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-(--border-input) px-3 py-2 text-xs leading-relaxed text-(--text-muted)" data-testid="chat-removed-notice">
      <IconBookRemoved className="mt-0.5 h-4 w-4 shrink-0 text-(--text-faint)" />
      <span>{children}</span>
    </div>
  );
}

function composerPlaceholder(scope: ConversationScope, isNew: boolean): string {
  if (scope.kind === "books") {
    const present = scope.books.filter((book) => book.available);
    const [only] = present;
    if (present.length === 1 && only) return `Ask about ${only.title}…`;
    if (present.length > 1) return present.length < scope.books.length ? `Ask about the ${present.length} remaining books…` : `Ask about these ${present.length} books…`;
  }
  return isNew ? "Ask your first question…" : "Ask a follow-up…";
}

export function ConversationPane({
  open,
  preset,
  relatedCount,
  model,
  folders,
  libraryNote,
  onCreated,
  onNewChat,
}: {
  open: OpenConversation | null;
  preset: NewChatPreset;
  // Conversations already had about the preset book — the sidebar is showing them
  relatedCount: number;
  model: string;
  folders: FolderOption[];
  libraryNote: string;
  onCreated: (id: string) => void;
  // Given the sources of the conversation it was pressed in, so the next chat starts on them
  onNewChat: (from?: ConversationScope) => void;
}) {
  const utils = trpc.useUtils();
  const { data: bookOptions = [] } = trpc.chats.bookOptions.useQuery(undefined, { enabled: !open });
  const create = trpc.chats.create.useMutation();
  const stopRun = trpc.chats.stop.useMutation();

  const [conversation, setConversation] = useState<{ id: string; scope: ConversationScope } | null>(open);
  const [draft, setDraft] = useState<DraftScope>(() =>
    preset.draft ?? (preset.bookId ? { kind: "books", bookIds: [preset.bookId] } : preset.folderId ? { kind: "folder", folderId: preset.folderId } : { kind: "library" }));
  // A chat opened from a book starts on that book; the picker is one step away
  const [picking, setPicking] = useState(!preset.bookId || !!preset.draft);
  const [input, setInput] = useState("");
  const [stopped, setStopped] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{ fileId: string; page?: number; filename?: string } | null>(null);

  // The server keeps the transcript: a request names the conversation and carries the one
  // question, never a history to be believed. The id rides in each request's body because a new
  // chat has none until its first question creates it.
  const transport = useMemo(
    () => new DefaultChatTransport<StoredChatMessage>({
      api: "/chat",
      headers: () => profileHeaders(),
      prepareSendMessagesRequest: ({ messages, trigger, body }) => {
        const last = messages.at(-1);
        return {
          body: {
            ...body,
            trigger: trigger === "regenerate-message" ? "regenerate" : "submit",
            // A retry says which question it means and what it said: one refused before it was
            // saved exists only here, and the server would otherwise answer its own last question
            text: last?.role === "user" ? messageText(last) : "",
            question: messages.filter((message) => message.role === "user").length,
          },
        };
      },
    }),
    [],
  );
  const refreshHistory = () => void utils.chats.list.invalidate();
  const { messages: ownMessages, sendMessage, regenerate, setMessages, status, error, stop } = useChat<StoredChatMessage>({
    transport,
    // The one place the stored parts are named: they were written by this same SDK
    messages: open?.messages as StoredChatMessage[] | undefined,
    onFinish: refreshHistory,
    onError: refreshHistory,
  });
  const watching = !!open?.running;
  const messages = watching ? (open.messages as StoredChatMessage[]) : ownMessages;
  const answering = watching || status === "submitted" || status === "streaming";
  const busy = answering || create.isPending || stopRun.isPending;

  // The answer is followed only while the reader is at the bottom: scrolling up to read something
  // else lets go, and coming back down takes hold again. Where the reader is gets judged here,
  // against the height the pane had before this update — a scroll listener hears about it a frame
  // late, and a token landing in that frame pulled the pane back down from under the scroll that
  // was leaving.
  const scroller = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);
  // A conversation opens at its end, and asking is a request to see the answer
  const pinned = useRef(true);
  useEffect(() => {
    const pane = scroller.current;
    if (!pane) return;
    const atBottom = lastHeight.current - pane.scrollTop - pane.clientHeight < FOLLOW_WITHIN_PX;
    // Not smooth: an animation still on its way down reads as the reader having scrolled away
    if (atBottom || pinned.current) pane.scrollTop = pane.scrollHeight;
    pinned.current = false;
    lastHeight.current = pane.scrollHeight;
  }, [messages]);

  const isNew = conversation === null;
  const scope = conversation?.scope ?? draftAsScope(draft, bookOptions, folders);
  const { canAsk } = askable(scope);
  const ready = isNew ? draftReady(draft) : canAsk;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set(open?.removedBookIds));
  const removedBookIds = watching ? new Set(open.removedBookIds) : removed;

  // `busy` is a render behind: two Enters in one tick would both pass it and start two conversations
  const starting = useRef(false);
  const send = async () => {
    const text = input.trim();
    if (!text || busy || !ready || starting.current) return;
    starting.current = true;
    try {
      await start(text);
    } finally {
      starting.current = false;
    }
  };

  const start = async (text: string) => {
    setStartError(null);
    setStopped(false);
    let conversationId = conversation?.id;
    if (!conversationId) {
      try {
        const created = await create.mutateAsync({ scope: draft, model: model || undefined });
        conversationId = created.id;
        setConversation(created);
        onCreated(created.id);
      } catch (err) {
        setStartError(err instanceof Error ? err.message : "Could not start the conversation");
        return;
      }
    }
    setInput("");
    pinned.current = true;
    void sendMessage({ text }, { body: { conversationId, model: model || undefined } });
  };

  // Stop is a request to the server, which owns the run; closing the page is not one. It returns
  // once the run has let go, and only then can the question be asked again.
  const stopAnswer = async () => {
    if (!conversation) return;
    setStopped(true);
    await stopRun.mutateAsync({ id: conversation.id }).catch(() => undefined);
    await stop();
    // The kept answer has what the cut stream never delivered: the sources of what it had written
    const kept = await utils.chats.get.fetch({ id: conversation.id }).catch(() => null);
    if (kept && !kept.running) {
      setMessages(kept.messages as StoredChatMessage[]);
      setRemoved(new Set(kept.removedBookIds));
      setStopped(false);
    }
    refreshHistory();
  };

  const askAgain = () => {
    setStopped(false);
    pinned.current = true;
    void regenerate({ body: { conversationId: conversation?.id, model: model || undefined } });
  };

  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  const failure = errorText(error);
  const statusOf = (message: StoredChatMessage, index: number): AnswerStatus => {
    if (watching || index !== lastIndex || message.role !== "assistant") return message.metadata?.status ?? "complete";
    if (status === "submitted" || status === "streaming") return "streaming";
    if (failure) return "failed";
    if (stopped) return "stopped";
    return message.metadata?.status ?? "complete";
  };

  const retryFor = (index: number): AnswerRetry => ({
    onRetry: askAgain,
    disabledReason: index !== lastIndex
      ? "The conversation moved on — only the latest answer can be asked again"
      : !canAsk ? "Nothing this conversation searched is left in the library" : busy ? "Already answering" : null,
  });

  const questionBefore = (index: number): string => {
    for (let i = index - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "user") return messageText(message);
    }
    return "";
  };

  const presetBook = preset.bookId ? bookOptions.find((book) => book.id === preset.bookId) : undefined;
  // A question with nothing under it: refused before it began, or lost to a restart
  const unanswered = !busy && last?.role === "user";

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-none flex-wrap items-center gap-2 border-b border-(--border) bg-(--bg-page) px-3 py-2 md:px-6" data-testid="chat-sources-bar">
        {isNew && (
          <>
            <span className="text-sm font-bold text-(--text-primary)">New chat</span>
            <span className="text-(--text-faint)">·</span>
          </>
        )}
        <span className="flex-none text-xs font-bold uppercase tracking-wide text-(--text-muted)">Searching</span>
        <ScopeChips scope={scope} fixed={!isNew} />
        {!isNew && (
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-(--text-faint) lg:inline">Sources are fixed for this chat.</span>
            <Button variant="secondary" size="sm" onClick={() => onNewChat(scope)} title="Sources cannot change mid-conversation. A new chat starts on the same ones, and they can be changed before its first question." data-testid="chat-new-other">
              <IconAdd className="h-3 w-3" />
              <span className="hidden sm:inline">New chat</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-8 md:px-6" data-testid="chat-scroller">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <ModelBundleNotice id="search" verb="Searching and asking across the library" />

          {isNew && picking && (
            <SourcePicker draft={draft} onChange={setDraft} folders={folders} books={bookOptions} libraryNote={libraryNote} />
          )}
          {isNew && !picking && (
            <div className="mt-12 flex flex-col items-center gap-2 text-center" data-testid="chat-book-start">
              <IconBook className="h-10 w-10 text-(--text-faint)" />
              <h2 className="text-xl font-bold text-(--text-primary)">Ask about {presetBook?.title ?? "this book"}</h2>
              <p className="max-w-md text-sm leading-relaxed text-(--text-muted)">
                This is a new conversation.
                {relatedCount > 0 && ` The ${relatedCount === 1 ? "one" : relatedCount} you already had about this book ${relatedCount === 1 ? "is" : "are"} in the sidebar — pick ${relatedCount === 1 ? "it" : "one"} to continue it instead.`}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>Search something else</Button>
            </div>
          )}

          {!isNew && <RemovedNotice scope={scope} />}

          {messages.map((message, i) => (
            <ChatMessage
              key={message.id}
              message={message}
              status={statusOf(message, i)}
              error={i === lastIndex ? (failure ?? message.metadata?.error ?? null) : (message.metadata?.error ?? null)}
              retry={retryFor(i)}
              question={questionBefore(i)}
              folderId={scope.kind === "folder" ? scope.folderId : undefined}
              removedBookIds={removedBookIds}
              onOpenPdf={setPdfPreview}
            />
          ))}

          {answering && (
            <div className="flex items-center gap-2 text-sm text-(--text-muted)" data-testid="chat-busy">
              <span className="h-2 w-2 animate-pulse rounded-full bg-(--accent)" />
              {status === "submitted" ? "Searching the library…" : "Answering…"}
              <Button variant="secondary" size="sm" onClick={() => void stopAnswer()} disabled={stopRun.isPending || !conversation} data-testid="chat-stop">
                {stopRun.isPending ? "Stopping…" : "Stop"}
              </Button>
              <span className="text-xs text-(--text-faint)">Keeps going if this page is closed.</span>
            </div>
          )}

          {unanswered && (
            <div className="flex flex-wrap items-center gap-2.5 text-xs text-(--text-muted)" data-testid="chat-unanswered">
              <span className="min-w-0 flex-1">
                {failure ?? "This question was never answered. Nothing runs again on its own."}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={askAgain}
                disabled={!canAsk}
                title={canAsk ? "Answer this question" : "Nothing this conversation searched is left in the library"}
                data-testid="chat-ask-again"
              >
                <IconRerun className="h-3 w-3" />
                Ask again
              </Button>
            </div>
          )}
          {startError && <div className="text-sm text-(--danger-text)">{startError}</div>}
        </div>
      </div>

      <div className="flex-none border-t border-(--border) bg-(--bg-page) px-3 pt-2.5 pb-4 md:px-6">
        <div className="mx-auto max-w-3xl">
          {!isNew && !canAsk ? (
            <div className="flex items-center gap-3 rounded-lg border border-(--border) bg-(--bg-card) px-3 py-2.5 text-xs text-(--text-muted)" data-testid="chat-composer-closed">
              <IconBlocked className="h-4 w-4 shrink-0 text-(--text-faint)" />
              <span className="flex-1">
                Everything this conversation searched is gone, so there is nothing left to ask it. It will not fall back to the whole library.
              </span>
              <Button variant="primary" size="sm" onClick={() => onNewChat()}>
                <IconAdd className="h-3 w-3" />
                New chat
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder={composerPlaceholder(scope, isNew)}
                  className="flex-1 resize-none rounded-lg border border-(--border-input) bg-(--bg-card) px-3 py-2 text-sm text-(--text-primary) outline-none"
                  data-testid="chat-input"
                />
                <Button
                  variant="primary"
                  onClick={() => void send()}
                  disabled={busy || !input.trim() || !ready}
                  title={ready ? undefined : "Pick what to search first"}
                  data-testid="chat-send"
                >
                  Ask
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-(--text-faint)">
                {ready ? "Enter to send, Shift+Enter for a new line" : draft.kind === "books" ? "Pick at least one book first" : "Pick a folder first"}
              </p>
            </>
          )}
        </div>
      </div>

      {pdfPreview && (
        <PdfPreviewModal
          fileId={pdfPreview.fileId}
          page={pdfPreview.page}
          filename={pdfPreview.filename}
          onClose={() => setPdfPreview(null)}
        />
      )}
    </main>
  );
}
