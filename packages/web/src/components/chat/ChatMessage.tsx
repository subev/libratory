import { useState } from "react";
import type { UIMessage } from "ai";
import type { StoredChatMessage } from "../../../../server/src/lib/chats.ts";
import { trpc } from "../../trpc.ts";
import { Button } from "../Button.tsx";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { SourceList, type ChatSource } from "./SourceList.tsx";
import { IconSearch, IconCheck, IconFailed, IconRerun, IconStopped } from "../icons.tsx";

export type AnswerStatus = NonNullable<StoredChatMessage["metadata"]>["status"];

export type AnswerRetry = { onRetry: () => void; disabledReason: string | null };

export function messageText(message: UIMessage): string {
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

const ENDED = {
  stopped: { label: "Stopped", Icon: IconStopped, tone: "bg-(--warning-bg) text-(--warning-text)" },
  failed: { label: "Failed", Icon: IconFailed, tone: "bg-(--danger-bg) text-(--danger-text)" },
} as const;

function answeredLine(metadata: StoredChatMessage["metadata"]): string {
  if (!metadata) return "";
  const day = new Date(metadata.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return [metadata.modelLabel ?? metadata.modelKey, day].filter(Boolean).join(" · ");
}

// The partial text stays readable, the way it ended is said plainly, and nothing runs again
// until Ask again is pressed
function EndedFooter({ status, error, hasText, retry }: { status: "stopped" | "failed"; error: string | null; hasText: boolean; retry: AnswerRetry }) {
  const { label, Icon, tone } = ENDED[status];
  const what = status === "stopped"
    ? (hasText ? "Stopped before it was finished." : "Stopped before it wrote anything.")
    : (error ?? "The answer ended before it was finished.");
  return (
    <div className={`flex flex-wrap items-center gap-2.5 text-xs ${hasText ? "mt-3 border-t border-dashed border-(--border) pt-2.5" : ""}`} data-testid="chat-answer-ended">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <span className="min-w-0 flex-1 text-(--text-muted)">{what} Nothing runs again on its own.</span>
      <Button
        variant="secondary"
        size="sm"
        onClick={retry.onRetry}
        disabled={retry.disabledReason !== null}
        title={retry.disabledReason ?? "Answer this question again"}
        data-testid="chat-ask-again"
      >
        <IconRerun className="h-3 w-3" />
        Ask again
      </Button>
    </div>
  );
}

export function ChatMessage({
  message,
  status,
  error,
  retry,
  question,
  folderId,
  removedBookIds,
  onOpenPdf,
}: {
  message: StoredChatMessage;
  status: AnswerStatus;
  error: string | null;
  retry: AnswerRetry;
  question: string;
  folderId?: string;
  removedBookIds: ReadonlySet<string>;
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
  const ended = status === "stopped" || status === "failed" ? status : null;

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
      {(text || ended) && (
        <div className="max-w-full rounded-2xl rounded-bl-sm bg-(--bg-card) border border-(--border) px-4 py-3 md:max-w-[92%]">
          {text && <MarkdownBlock reading>{renderText(text, sources)}</MarkdownBlock>}
          <SourceList sources={sources} removedBookIds={removedBookIds} onOpenPdf={onOpenPdf} />
          {ended && <EndedFooter status={ended} error={error} hasText={!!text} retry={retry} />}
          {status === "complete" && (
            <div className="flex items-center gap-3 mt-2 text-xs">
              {savedNoteId ? (
                <span className="inline-flex items-center gap-1 text-(--success-text)">Saved to notes <IconCheck className="h-3 w-3" /></span>
              ) : (
                <button
                  onClick={() => saveNote.mutate({ question: question || "Library chat", markdown: text, model: message.metadata?.modelKey ?? undefined, folderId })}
                  disabled={saveNote.isPending}
                  className="text-(--text-faint) hover:text-(--text-secondary)"
                >
                  {saveNote.isPending ? "Saving…" : "Save as note"}
                </button>
              )}
              <span className="text-(--text-faint)">{answeredLine(message.metadata)}</span>
              {saveNote.error && <span className="text-(--danger-text)">{saveNote.error.message}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
