import { useState } from "react";
import type { UIMessage } from "ai";
import { trpc } from "../../trpc.ts";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { SourceChips, type ChatSource } from "./SourceChips.tsx";
import { IconSearch, IconCheck } from "../icons.tsx";

function messageText(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

export function messageSources(message: UIMessage): ChatSource[] {
  for (const part of [...(message.parts ?? [])].reverse()) {
    if (part.type === "data-sources" && Array.isArray((part as { data?: unknown }).data)) {
      return (part as { data: ChatSource[] }).data;
    }
  }
  return [];
}

// Rewrites verified [c_N] markers to reader-facing [n] numbering; unverified ids vanish
function renderText(text: string, sources: ChatSource[]): string {
  const order = new Map(sources.map((s, i) => [s.id, i + 1]));
  return text.replace(/\s?\[(c_\d+)\]/g, (_, id: string) => (order.has(id) ? ` [${order.get(id)}]` : ""));
}

function toolLabel(part: { type: string; input?: unknown; state?: string }): string | null {
  const input = (part.input ?? {}) as Record<string, unknown>;
  if (part.type === "tool-search_library") return `Searched: ${String(input.query ?? "…")}`;
  if (part.type === "tool-read_passage") return `Read more around ${String(input.id ?? "…")}`;
  if (part.type === "tool-list_books") return input.query ? `Listed books: ${String(input.query)}` : "Listed books";
  return null;
}

export function ChatMessage({
  message,
  question,
  model,
  folderId,
  onOpenPdf,
}: {
  message: UIMessage;
  question: string;
  model: string;
  folderId?: string;
  onOpenPdf: (args: { fileId: string; page?: number; filename?: string }) => void;
}) {
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
  const saveNote = trpc.notes.saveLibraryAnswer.useMutation({
    onSuccess: (data) => setSavedNoteId(data.noteId),
  });

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-(--accent) text-(--on-accent) text-sm px-4 py-2 whitespace-pre-wrap">
          {messageText(message)}
        </div>
      </div>
    );
  }

  const sources = messageSources(message);
  const text = messageText(message);

  return (
    <div className="flex flex-col items-start gap-1" data-testid="chat-assistant-message">
      {(message.parts ?? []).map((part, i) => {
        const label = toolLabel(part as { type: string; input?: unknown });
        if (!label) return null;
        return (
          <div key={i} className="flex items-center gap-1.5 text-xs text-(--text-faint)">
            <IconSearch className="w-3 h-3" />
            {label}
          </div>
        );
      })}
      {text && (
        <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-(--bg-card) border border-(--border) px-4 py-3">
          <MarkdownBlock>{renderText(text, sources)}</MarkdownBlock>
          <SourceChips sources={sources} onOpenPdf={onOpenPdf} />
          <div className="flex items-center gap-2 mt-2">
            {savedNoteId ? (
              <span className="inline-flex items-center gap-1 text-xs text-(--success-text)">Saved to notes <IconCheck className="h-3 w-3" /></span>
            ) : (
              <button
                onClick={() => saveNote.mutate({ question: question || "Library chat", markdown: text, model, folderId })}
                disabled={saveNote.isPending}
                className="text-xs text-(--text-faint) hover:text-(--text-secondary)"
              >
                {saveNote.isPending ? "Saving…" : "Save as note"}
              </button>
            )}
            {saveNote.error && <span className="text-xs text-(--danger-text)">{saveNote.error.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
