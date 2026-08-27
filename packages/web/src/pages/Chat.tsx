import { useMemo, useRef, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { trpc } from "../trpc.ts";
import { profileHeaders } from "../lib/profile.ts";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { ChatMessage } from "../components/chat/ChatMessage.tsx";
import { SavedAnswers } from "../components/chat/SavedAnswers.tsx";
import { PdfPreviewModal } from "../components/PdfPreviewModal.tsx";
import { ModelBundleNotice } from "../components/ModelBundleNotice.tsx";

type FolderOption = { id: string; name: string; depth: number };

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

export function Chat() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folderId = searchParams.get("folderId") ?? undefined;
  const bookId = searchParams.get("bookId") ?? undefined;
  const { data: scopedBook } = trpc.books.get.useQuery({ id: bookId! }, { enabled: !!bookId });
  const [model, setModel] = useState<string>("");
  const [input, setInput] = useState("");
  const [pdfPreview, setPdfPreview] = useState<{ fileId: string; page?: number; filename?: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: folders = [] } = trpc.folders.list.useQuery();
  const { data: indexStatus } = trpc.search.indexStatus.useQuery();
  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/chat", headers: () => profileHeaders() }),
    [],
  );
  const { messages, sendMessage, setMessages, status, error, stop } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const newChat = () => {
    stop();
    setMessages([]);
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text }, { body: { scope: { folderId, bookId }, model } });
  };

  const lastQuestionBefore = (index: number): string => {
    for (let i = index - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") {
        return (m.parts ?? [])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ");
      }
    }
    return "";
  };

  const notIndexed = indexStatus ? indexStatus.total - indexStatus.done : 0;

  return (
    <div className="min-h-screen bg-(--bg-page)">
      <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col min-h-screen">
        <div className="flex items-center gap-3 mb-4">
          <Link to="/" className="text-(--text-faint) hover:text-(--text-secondary) text-sm">← Library</Link>
          <h1 className="text-xl font-bold text-(--text-primary)">Library chat</h1>
          <div className="ml-auto flex items-center gap-2">
            {messages.length > 0 && (
              <button
                onClick={newChat}
                className="text-sm px-2.5 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-(--text-muted) hover:text-(--text-primary)"
                data-testid="chat-new"
              >
                New chat
              </button>
            )}
            {bookId ? (
              <span
                className="inline-flex items-center gap-1.5 max-w-72 text-sm px-2.5 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-(--text-primary)"
                data-testid="chat-book-scope"
              >
                <span className="truncate" title={scopedBook?.title}>📖 {scopedBook?.title ?? "…"}</span>
                <button
                  onClick={() => setSearchParams({})}
                  className="text-(--text-faint) hover:text-(--text-secondary) shrink-0"
                  title="Widen scope to the whole library"
                >
                  ✕
                </button>
              </span>
            ) : (
            <select
              value={folderId ?? ""}
              onChange={(e) => setSearchParams(e.target.value ? { folderId: e.target.value } : {})}
              className="text-sm rounded-md border border-(--border) bg-(--bg-card) text-(--text-primary) px-2 py-1.5"
              data-testid="chat-scope"
            >
              <option value="">Whole library</option>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {"  ".repeat(f.depth)}📁 {f.name}
                </option>
              ))}
            </select>
            )}
            <ModelPicker value={model} onChange={setModel} requireTools testId="chat-model" />
          </div>
        </div>

        <div className="mb-3"><ModelBundleNotice id="search" verb="Searching and asking across the library" /></div>

        {notIndexed > 0 && (
          <div className="text-xs text-(--text-muted) mb-3" data-testid="chat-index-hint">
            {notIndexed} book{notIndexed === 1 ? " is" : "s are"} not fully indexed yet — answers may miss them.
            {indexStatus!.running > 0 && ` Indexing ${indexStatus!.running} now…`}
          </div>
        )}

        <div className="flex-1 flex flex-col gap-4 pb-6">
          {messages.length === 0 && (
            <div className="text-sm text-(--text-muted) mt-12 text-center space-y-2">
              <p className="text-base">Ask anything about the books in your library.</p>
              <p>The assistant searches across all book text — originals and translations, English or Bulgarian — and cites the passages it used. Click a source to open the book at that spot.</p>
            </div>
          )}
          {messages.map((message, i) => (
            <ChatMessage
              key={message.id}
              message={message}
              question={lastQuestionBefore(i)}
              model={model}
              folderId={folderId}
              onOpenPdf={setPdfPreview}
            />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-(--text-muted)" data-testid="chat-busy">
              <span className="w-2 h-2 rounded-full bg-sky-500 animate-pulse" />
              {status === "submitted" ? "Searching the library…" : "Answering…"}
              <button onClick={() => stop()} className="text-xs underline text-(--text-faint) hover:text-(--text-secondary)">Stop</button>
            </div>
          )}
          {error && <div className="text-sm text-red-600">{error.message}</div>}
          <div ref={bottomRef} />
        </div>

        <div className="sticky bottom-0 bg-(--bg-page) pb-6 pt-2">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Ask your library… (Enter to send, Shift+Enter for newline)"
              className="flex-1 resize-none rounded-lg border border-(--border) bg-(--bg-card) text-(--text-primary) text-sm px-3 py-2 outline-none focus:border-blue-500"
              data-testid="chat-input"
            />
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
              data-testid="chat-send"
            >
              Ask
            </button>
          </div>
          <SavedAnswers />
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
    </div>
  );
}
