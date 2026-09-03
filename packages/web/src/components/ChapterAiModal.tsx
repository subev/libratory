import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { trpc } from "../trpc.ts";
import { profileHeaders } from "../lib/profile.ts";
import { MarkdownBlock } from "./MarkdownBlock.tsx";
import { Modal, ModalHeader } from "./Modal.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { AI_PRESETS, estimateTokens, estimateTokensFromCounts, formatTokens } from "../lib/ai-presets.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { PillToggle } from "./PillToggle.tsx";
import { useActiveLlmModel } from "../lib/use-llm-models.ts";
import { Button } from "./Button.tsx";

export type AiScope =
  | { kind: "chapters"; bookId: string; chapters: { id: string; title: string }[] }
  | { kind: "book-raw"; bookId: string; bookTitle: string; chapters?: { id: string; title: string }[] };

function lastAssistant(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return message;
  }
  return null;
}

function textOf(message: UIMessage | null): string {
  return (message?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function noteIdOf(message: UIMessage | null): string | null {
  for (const part of message?.parts ?? []) {
    if (part.type === "data-note") {
      const data = (part as { data?: { noteId?: string } }).data;
      if (data?.noteId) return data.noteId;
    }
  }
  return null;
}

export function ChapterAiModal({ scope, onClose }: { scope: AiScope; onClose: () => void }) {
  const utils = trpc.useUtils();
  const chapterSelection = scope.chapters ?? [];
  const [kind, setKind] = useState<"book-raw" | "chapters">(
    scope.kind === "chapters" && chapterSelection.length > 0 ? "chapters" : "book-raw",
  );

  // Cached by BookDetail's own query — no extra request in practice
  const { data: book } = trpc.books.get.useQuery({ id: scope.bookId });
  const bookTitle = scope.kind === "book-raw" ? scope.bookTitle : (book?.title ?? "this book");
  const hasRawText = (book?.rawTextTotalWords ?? 0) > 0;

  const onlyChapter = chapterSelection.length === 1 ? chapterSelection[0] : undefined;
  const subject = kind === "book-raw" ? "book" : onlyChapter ? "chapter" : "chapters";
  const [activePreset, setActivePreset] = useState<string>("summarize");
  const [prompt, setPrompt] = useState<string>(AI_PRESETS[0].prompt(subject));
  const [model, setModel] = useState<string>("");

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/chat/ask", headers: () => profileHeaders() }),
    [],
  );
  const { messages, sendMessage, setMessages, status, error, stop } = useChat({ transport });
  const pending = status === "submitted" || status === "streaming";

  const answer = lastAssistant(messages);
  const result = textOf(answer);
  const savedNoteId = noteIdOf(answer);
  const [invalidatedFor, setInvalidatedFor] = useState<string | null>(null);
  if (savedNoteId && invalidatedFor !== savedNoteId) {
    setInvalidatedFor(savedNoteId);
    utils.notes.list.invalidate({ bookId: scope.bookId });
  }

  const chapterIds = chapterSelection.map((c) => c.id);
  const { data: chapterStats } = trpc.chapters.textStats.useQuery(
    { chapterIds },
    { enabled: kind === "chapters" && chapterIds.length > 0 },
  );
  const { data: rawStats } = trpc.books.rawTextStats.useQuery(
    { bookId: scope.bookId },
    { enabled: kind === "book-raw" },
  );
  const textStats = kind === "book-raw" ? rawStats : chapterStats;

  const activeModel = useActiveLlmModel(model);
  const contentTokens = textStats
    ? estimateTokensFromCounts(textStats.ascii, textStats.nonAscii) + estimateTokens(prompt)
    : null;
  const contextPct = contentTokens && activeModel ? (contentTokens / activeModel.contextTokens) * 100 : null;
  const overContext = contextPct !== null && contextPct > 100;

  const scopeOptions = [
    {
      key: "book-raw" as const,
      label: "Whole book (raw)",
      disabled: !hasRawText,
      title: hasRawText ? `The full raw text of "${bookTitle}"` : "No raw text available for this book",
    },
    {
      key: "chapters" as const,
      label: onlyChapter ? `Chapter: ${onlyChapter.title}` : `Selected chapters (${chapterSelection.length})`,
      disabled: chapterSelection.length === 0,
      title: chapterSelection.length === 0 ? "No chapters selected — select chapters in the table first" : chapterSelection.map((c) => c.title).join("\n"),
    },
  ];

  function switchKind(next: "book-raw" | "chapters") {
    setKind(next);
    const preset = AI_PRESETS.find((p) => p.key === activePreset);
    const nextSubject = next === "book-raw" ? "book" : chapterSelection.length === 1 ? "chapter" : "chapters";
    if (preset && prompt === preset.prompt(subject)) setPrompt(preset.prompt(nextSubject));
  }

  function selectPreset(key: string) {
    const preset = AI_PRESETS.find((p) => p.key === key)!;
    setActivePreset(key);
    setPrompt(preset.prompt(subject));
  }

  function run() {
    if (!prompt.trim() || pending || overContext) return;
    setMessages([]);
    setInvalidatedFor(null);
    const serverScope =
      kind === "book-raw"
        ? { kind: "book-raw" as const, bookId: scope.bookId }
        : { kind: "chapters" as const, chapterIds };
    void sendMessage({ text: prompt.trim() }, { body: { scope: serverScope, model } });
  }

  return (
    <Modal size="lg" onClose={onClose} closeOnEscape={false} /* a typed prompt and its answer are not restored on reopen */ testId="chapter-ai-modal">
      <ModalHeader title="Ask about" onClose={onClose}>
        <SegmentedControl
          options={scopeOptions.map((option) => ({ id: option.key, label: option.label, title: option.title, disabled: option.disabled }))}
          value={kind}
          onChange={(next) => switchKind(next as "book-raw" | "chapters")}
          testId="ai-scope-toggle"
        />
      </ModalHeader>

      <div className="flex-1 flex min-h-0">
        {/* Left: presets + prompt */}
        <div className="w-2/5 border-r border-(--border) p-4 flex flex-col gap-3 min-h-0">
          {/* The artboard's framing, because the two doors are easy to confuse: this one sends the
              whole text in a single request, Chat searches it and cites pages across turns. */}
          <p className="text-xs text-(--text-muted)">
            The text below is sent in one request — one prompt, one answer, saved to Notes. For a
            back-and-forth that searches the book and cites pages, use{" "}
            <Link to={`/chat?bookId=${scope.bookId}`} className="text-(--accent-text) hover:underline font-medium">
              Chat
            </Link>
            .
          </p>
          <div className="flex flex-wrap gap-1.5">
            {AI_PRESETS.map((p) => (
              <PillToggle
                key={p.key}
                selected={activePreset === p.key}
                onClick={() => selectPreset(p.key)}
              >
                {p.label}
              </PillToggle>
            ))}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
            }}
            className="flex-1 resize-none rounded-md border border-(--border-input) bg-(--bg-input) p-3 text-sm text-(--text-primary) leading-relaxed"
            placeholder={`Ask anything about this ${subject === "chapters" ? "selection" : subject}...`}
            data-testid="ai-prompt-input"
          />
          {contentTokens !== null && contextPct !== null && activeModel && (
            <div className="shrink-0" data-testid="ai-context-usage" title={`Rough estimate — the ${subject === "book" ? "book's raw text" : "chapter text"} plus your prompt, sent in full to ${activeModel.label}`}>
              <div className="flex items-baseline justify-between text-xs text-(--text-faint) mb-1">
                <span>
                  Sends up to ≈ {formatTokens(contentTokens)} tokens
                  {kind === "chapters" && chapterSelection.length > 1 ? ` (${chapterSelection.length} chapters)` : ""}
                  {kind === "book-raw" && rawStats && rawStats.missingFiles > 0 ? ` (${rawStats.missingFiles} file(s) without raw text excluded)` : ""}
                </span>
                <span className={overContext ? "text-(--danger-text) font-medium" : ""}>
                  {contextPct < 0.1 ? "<0.1" : contextPct.toFixed(1)}% of {activeModel.label}'s {formatTokens(activeModel.contextTokens)} context
                </span>
              </div>
              <div className="h-1 rounded-full bg-(--bg-subtle) overflow-hidden">
                <div
                  className={`h-full rounded-full ${contextPct > 80 ? "bg-(--danger)" : "bg-(--accent)"}`}
                  style={{ width: `${Math.min(100, Math.max(0.5, contextPct))}%` }}
                />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 shrink-0">
            <ModelPicker value={model} onChange={setModel} testId="ai-model-toggle" />
            <Button
              variant="primary"
              onClick={run}
              disabled={!prompt.trim() || pending || overContext}
              title={overContext ? `The ${subject === "book" ? "book's raw text" : "selected chapters"} exceed this model's context window` : "Cmd+Enter"}
              className="flex-1"
              data-testid="ai-run"
            >
              {pending ? "Answering..." : "Ask"}
            </Button>
          </div>
        </div>

        {/* Right: result (streams in) */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-y-auto overscroll-contain p-4">
            {pending && !result ? (
              <div className="flex items-center gap-2 text-sm text-(--text-muted)">
                <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" />
                {activeModel?.label ?? "The model"} is reading the {subject === "book" ? "book" : "chapter"}...
                <button onClick={() => stop()} className="text-xs underline text-(--text-faint) hover:text-(--text-secondary)">Stop</button>
              </div>
            ) : error && !result ? (
              <p className="text-sm text-(--danger-text) whitespace-pre-wrap">{error.message}</p>
            ) : result ? (
              <MarkdownBlock testId="ai-result">{result}</MarkdownBlock>
            ) : (
              <p className="text-sm text-(--text-faint)">
                Pick a preset or write your own prompt, then hit Ask. The full {subject === "book" ? "raw book text" : "chapter text"} is sent along with it.
              </p>
            )}
          </div>
          {result && (
            <div className="border-t border-(--border) px-4 py-2 shrink-0 flex items-center gap-3">
              {pending ? (
                <button onClick={() => stop()} className="text-xs text-(--text-muted) hover:text-(--text-secondary) font-medium">
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => navigator.clipboard.writeText(result)}
                  className="text-xs text-(--text-muted) hover:text-(--text-secondary) font-medium"
                >
                  Copy result
                </button>
              )}
              {savedNoteId && (
                <span className="text-xs text-(--success-text)" data-testid="ai-saved-note">
                  Saved to notes
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
