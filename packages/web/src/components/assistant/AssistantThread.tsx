import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessagePart, type UIDataTypes, type UITools } from "ai";
import { useLocation, useNavigate } from "react-router";
import { APP_TARGETS, describeTarget, type AppTarget, type ShowInApp } from "../../../../server/src/lib/assistant-targets.ts";
import type { StoredChatMessage } from "../../../../server/src/lib/chats.ts";
import { trpc } from "../../trpc.ts";
import { profileHeaders } from "../../lib/profile.ts";
import { screenOf } from "../../lib/assistant-screen.ts";
import { nextStep } from "../../lib/assistant-next-step.ts";
import { AI_PRESETS } from "../../lib/ai-presets.ts";
import { saveThread } from "../../lib/assistant-prefs.ts";
import { captureDrop, droppedPdfs, hasFiles } from "../../lib/dnd.ts";
import { BundleChoice, bundleSentence, StagedChips, useStagedChips, type Bundle } from "./StagedChips.tsx";
import { PdfPreviewModal } from "../PdfPreviewModal.tsx";
import { SourceList, type ChatSource } from "../chat/SourceList.tsx";
import { ActionCard, type ToolPart } from "./ActionCard.tsx";
import { isAssistantTool, TOOL_TIERS } from "../../../../server/src/lib/assistant-tiers.ts";
import { Button } from "../Button.tsx";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { ModelPicker } from "../ModelPicker.tsx";
import { messageSources, messageText, renderText } from "../../lib/chat-message.ts";
import { useAssistant, type PinnedText } from "./context.tsx";
import { IconArrowRight, IconAttach, IconBook, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconFailed, IconRerun, IconSearch, IconSend, IconStop, IconStopped, IconTip, IconUpload } from "../icons.tsx";

// How close to the bottom still counts as reading the newest line
const FOLLOW_WITHIN_PX = 80;

// What each look-up is called in the trace. Read-only tools only: the rest do not reach the panel yet.
const TRACE: Record<string, (input: Record<string, unknown>) => string> = {
  list_books: (input) => (input.query ? `Looked for “${String(input.query)}”` : "Looked at the library"),
  get_book: () => "Checked the book",
  wait_for_book: () => "Waited for the book",
  get_book_text: () => "Read the text",
  get_chapter: () => "Read a chapter",
  inspect_pdf: () => "Checked a PDF",
  list_voices: (input) => (input.language ? `Listed ${String(input.language)} voices` : "Listed the voices"),
  get_capabilities: () => "Checked what this Mac can do",
  search_library: (input) => `Searched: ${String(input.query ?? "…")}`,
  read_passage: () => "Read around a passage",
  list_notes: () => "Looked at the notes",
};

// The model's reasoning, collapsed: a sweep while it thinks, one quiet line once it has, and the
// words themselves a click away for whoever wants them
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-(--text-faint)" data-testid="assistant-thinking">
      {/* button-ok: a disclosure for the reasoning, not an action */}
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 hover:text-(--text-secondary)" aria-expanded={open}>
        {open ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />}
        <span className={live ? "thinking-sweep" : ""}>{live ? "Thinking…" : "Thought about it"}</span>
      </button>
      {open && <p className="mt-1 whitespace-pre-wrap border-l border-(--border) pl-2 text-(--text-muted)">{text}</p>}
    </div>
  );
}

// The SDK's own part type is a deep union; the card reads a few fields off it and nothing more.
// MCP tools arrive as dynamic-tool parts with the name inside; show_in_app is a static tool of the
// server's own, whose name is in the part's type.
function toolPartOf(part: UIMessagePart<UIDataTypes, UITools>): ToolPart | null {
  return isToolUIPart(part) ? { ...part, toolName: getToolName(part) } : null;
}

// A look-up folds into the trace; anything that changes something is a card
function isLookup(part: ToolPart): boolean {
  return isAssistantTool(part.toolName) && TOOL_TIERS[part.toolName] === "read";
}

const NAVIGATION = "show_in_app";

// The assistant's sources carry no removed-book bookkeeping: a link into a gone book simply 404s
const NO_REMOVED: ReadonlySet<string> = new Set();

// Where the answer took the person: one line, like a look-up, since nothing changed. The input is
// read defensively: while the call streams in it is partial, and a target the model made up is
// not one the URL builder knows.
function Went({ part }: { part: ToolPart }) {
  const input = (part.input ?? {}) as Partial<ShowInApp>;
  const target = APP_TARGETS.find((t): t is AppTarget => t === input.target);
  const label = part.state === "output-error"
    ? `Could not open that: ${part.errorText ?? "unknown place"}`
    : part.state === "output-available" && target
      ? describeTarget({ ...input, target })
      : "Opening…";
  return (
    <div className="flex items-center gap-1.5 text-xs text-(--text-faint)" data-testid="assistant-went">
      <IconArrowRight className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}

function traceLabel(part: ToolPart): string {
  const label = TRACE[part.toolName];
  return label ? label((part.input ?? {}) as Record<string, unknown>) : part.toolName;
}

// One line for a run of look-ups, opening to the calls themselves
function Trace({ parts }: { parts: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  const running = parts.some((p) => p.state === "input-streaming" || p.state === "input-available");
  const [first] = parts;
  if (!first) return null;
  const summary = parts.length === 1 ? traceLabel(first) : `${traceLabel(first)} · ${parts.length - 1} more`;
  return (
    <div className="text-xs text-(--text-faint)" data-testid="assistant-trace">
      {/* button-ok: a disclosure for the trace, not an action */}
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 hover:text-(--text-secondary)" aria-expanded={open}>
        {open ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />}
        <IconSearch className={`h-3 w-3 ${running ? "animate-pulse" : ""}`} />
        <span>{running ? "Looking…" : summary}</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-1 border-l border-(--border) pl-2">
          {parts.map((p) => (
            <li key={p.toolCallId} className="font-mono">
              {p.toolName}({JSON.stringify(p.input ?? {})}){p.state === "output-error" ? ` — ${p.errorText ?? "failed"}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Consecutive look-ups fold into one trace; an action is a card; text stands on its own
function Answer({ message, question, live, busy, restored, ended, error, onRetry, onRespond, onUndo, onOpenPdf }: {
  message: StoredChatMessage;
  // What it answers, for the note it can be saved as
  question: string;
  live: boolean;
  busy: boolean;
  restored: boolean;
  ended: "stopped" | "failed" | null;
  error: string | null;
  // Only the latest answer can be asked again; an older one is history
  onRetry: (() => void) | null;
  onRespond: (approvalId: string, approved: boolean) => void;
  onUndo: (toolCallId: string) => void;
  onOpenPdf: (args: { fileId: string; page?: number; filename?: string }) => void;
}) {
  const sources = messageSources(message);
  const groups: ({ kind: "tools"; parts: ToolPart[] } | { kind: "action"; part: ToolPart } | { kind: "went"; part: ToolPart } | { kind: "thinking"; text: string; done: boolean } | { kind: "text"; text: string })[] = [];
  for (const part of message.parts) {
    const tool = toolPartOf(part);
    if (part.type === "reasoning") {
      if (part.text.trim()) groups.push({ kind: "thinking", text: part.text, done: part.state === "done" });
    } else if (tool && tool.toolName === NAVIGATION) {
      groups.push({ kind: "went", part: tool });
    } else if (tool && !isLookup(tool)) {
      groups.push({ kind: "action", part: tool });
    } else if (tool) {
      const last = groups.at(-1);
      if (last?.kind === "tools") last.parts.push(tool);
      else groups.push({ kind: "tools", parts: [tool] });
    } else if (part.type === "text" && part.text.trim()) {
      const last = groups.at(-1);
      if (last?.kind === "text") last.text += part.text;
      else groups.push({ kind: "text", text: part.text });
    }
  }
  return (
    <div className="space-y-2" data-testid="assistant-answer">
      {groups.map((group, i) =>
        group.kind === "tools"
          ? <Trace key={group.parts[0]?.toolCallId ?? i} parts={group.parts} />
          : group.kind === "action"
            ? <ActionCard key={group.part.toolCallId} part={group.part} live={live} busy={busy} restored={restored} offeredAt={message.metadata?.createdAt ?? null} onRespond={onRespond} onUndo={onUndo} />
            : group.kind === "went"
              ? <Went key={group.part.toolCallId} part={group.part} />
              : group.kind === "thinking"
                ? <Thinking key={`thinking-${i}`} text={group.text} live={live && busy && !group.done} />
                : <MarkdownBlock key={`text-${i}`} sans>{renderText(group.text, sources)}</MarkdownBlock>,
      )}
      {sources.length > 0 && <SourceList sources={sources} removedBookIds={NO_REMOVED} onOpenPdf={onOpenPdf} inPlace />}
      {!ended && !(live && busy) && message.metadata?.status === "complete" && groups.some((g) => g.kind === "text") && (
        <AnsweredLine message={message} question={question} sources={sources} />
      )}
      {ended && (
        <div className="flex items-center gap-2 text-xs text-(--text-muted)" data-testid="assistant-answer-ended">
          {ended === "stopped" ? <IconStopped className="h-3 w-3 text-(--warning-text)" /> : <IconFailed className="h-3 w-3 text-(--danger-text)" />}
          <span className="min-w-0 flex-1">{ended === "stopped" ? "Stopped before it was finished." : (error ?? "The answer ended before it was finished.")}</span>
          {onRetry && (
            <Button size="sm" onClick={onRetry} disabled={busy}>
              <IconRerun className="h-3 w-3" />
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Under a finished answer: which model wrote it, and a one-click save as a note of the library —
// the kind the Saved answers list shows, and that deleting the thread leaves alone
function AnsweredLine({ message, question, sources }: { message: StoredChatMessage; question: string; sources: ChatSource[] }) {
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
  const saveNote = trpc.notes.saveLibraryAnswer.useMutation({ onSuccess: (data) => setSavedNoteId(data.noteId) });
  const meta = message.metadata;
  const day = meta ? new Date(meta.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-(--text-faint)">
      {savedNoteId ? (
        <span className="inline-flex items-center gap-1 text-(--success-text)" data-testid="assistant-saved">Saved to notes <IconCheck className="h-3 w-3" /></span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => saveNote.mutate({ question: question || "Assistant", markdown: renderText(messageText(message), sources), model: meta?.modelKey ?? undefined })}
          disabled={saveNote.isPending}
          data-testid="assistant-save-note"
        >
          {saveNote.isPending ? "Saving…" : "Save as note"}
        </Button>
      )}
      <span>{[meta?.modelLabel ?? meta?.modelKey, day].filter(Boolean).join(" · ")}</span>
      {saveNote.error && <span className="text-(--danger-text)">{saveNote.error.message}</span>}
    </div>
  );
}

// `send` is what goes to the model when it differs from the label — a preset's full prompt
function Suggestion({ text, send, onAsk, disabled }: { text: string; send?: string; onAsk: (text: string) => void; disabled: boolean }) {
  return (
    <Button size="sm" onClick={() => onAsk(send ?? text)} disabled={disabled} className="max-w-full">
      <span className="truncate">{text}</span>
    </Button>
  );
}

// The first view on a book page: one thing to do next and two things to ask. The three-step list
// is the answer to a question, not a fixture of the panel.
function NextStepCard({ bookId, onAsk, disabled, presets }: { bookId: string; onAsk: (text: string) => void; disabled: boolean; presets: boolean }) {
  // Polled only while the book is working; a settled book's next step does not change on its own
  const { data: book } = trpc.books.get.useQuery({ id: bookId }, { refetchInterval: (q) => (q.state.data && nextStep(q.state.data).action === null ? 5000 : false) });
  if (!book) return null;
  const step = nextStep(book);
  return (
    <div className="space-y-3" data-testid="assistant-next-step">
      <div className="rounded-md border border-(--border) bg-(--bg-card) p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--text-muted)">
          <IconTip className="h-3 w-3" />
          Next step for this book
        </p>
        <p className="mt-1 text-sm font-medium text-(--text-primary)">{step.title}</p>
        <p className="mt-1 text-sm text-(--text-secondary)">{step.body}</p>
        {step.action && (
          <Button variant="primary" size="sm" to={step.action.to} className="mt-3">
            {step.action.label}
          </Button>
        )}
      </div>
      <div className="flex flex-col items-start gap-1.5">
        {step.questions.map((q) => <Suggestion key={q} text={q} onAsk={onAsk} disabled={disabled} />)}
      </div>
      {/* The Ask AI presets, now asked through the assistant: each becomes a whole-text read it confirms first.
          Not while text is pinned under the composer — the same presets sit there, over that text. */}
      {presets && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="assistant-presets">
          <span className="text-xs text-(--text-muted)">Read the whole book:</span>
          {AI_PRESETS.map((preset) => <Suggestion key={preset.key} text={preset.label} send={preset.prompt("book")} onAsk={onAsk} disabled={disabled} />)}
        </div>
      )}
    </div>
  );
}

const LIBRARY_QUESTIONS = ["How do I turn a PDF into an audiobook?", "What can you do from here?", "Which voices are free?"];

// The same words the server keeps for it
const EMPTY_ANSWER = "The model answered with nothing — try again";

// What a send with files and no words says
const FILES_ONLY_TEXT = "Here are the files.";

// The server writes each dropped file's staged:<id> into the question for the model; the person
// sees the name and size, not the id
const STAGED_REF = /,\s*staged:[0-9a-f-]{36}/g;
// The ids the server wrote beside pinned text, for the model; the person reads the titles
const READ_ID = /\s\((?:bookId|chapter) [0-9a-f-]{36}\)/g;
function questionText(text: string): string {
  return text.replace(STAGED_REF, "").replace(READ_ID, "");
}

// The chip under the composer: what is pinned to be read
function pinnedLabel(pinned: PinnedText): string {
  if (!pinned.chapters) return `Whole book${pinned.bookTitle ? ` · ${pinned.bookTitle}` : ""}`;
  const n = pinned.chapters.length;
  return `${n} chapter${n === 1 ? "" : "s"} · ${pinned.chapters.map((c) => c.title).join(", ")}`;
}

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

// `closed` is why the thread can be read but not continued: everything it searched is gone, and a
// scope is never widened to the library on its own
export type OpenThread = { id: string; messages: StoredChatMessage[]; removedBookIds?: string[]; closed?: string | null };

// One assistant thread: the transcript, the composer and the first-view card. The server keeps the
// transcript; a request carries one question and where the person is. `watching` is a thread being
// answered by a run this window did not start: the transcript then comes from the server, poll by
// poll, and the composer waits.
type ScopeInput = { kind: "screen" } | { kind: "library" } | { kind: "folder"; folderId: string } | { kind: "books"; bookIds: string[] };

export function AssistantThread({ open, watching = false, profileId, scope, onCreated }: { open: OpenThread | null; watching?: boolean; profileId: string; scope: ScopeInput; onCreated: (id: string) => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const create = trpc.chats.create.useMutation();
  const stopRun = trpc.chats.stop.useMutation();
  const [conversationId, setConversationId] = useState<string | null>(open?.id ?? null);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [dropping, setDropping] = useState<number | null>(null);
  const attachments = useStagedChips();
  const [bundle, setBundle] = useState<Bundle>("one");
  const [pdfPreview, setPdfPreview] = useState<{ fileId: string; page?: number; filename?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const screen = screenOf(location.pathname);

  const transport = useMemo(
    () => new DefaultChatTransport<StoredChatMessage>({
      api: "/assistant",
      headers: () => profileHeaders(),
      prepareSendMessagesRequest: ({ messages, trigger, body }) => {
        const last = messages.at(-1);
        // A card answered: the last message is the assistant's, holding the response. The server
        // runs the call and goes on in that same message. The page and the model ride in `body`,
        // handed over with the response itself.
        // Every card answered in this turn goes together: the SDK waits until none is left open
        const approvals = trigger === "submit-message" && last?.role === "assistant"
          ? last.parts.map(toolPartOf).flatMap((p) => (p?.state === "approval-responded" && p.approval ? [{ id: p.approval.id, approved: p.approval.approved }] : []))
          : [];
        if (approvals.length > 0) return { body: { ...body, trigger: "approval", approvals } };
        return {
          body: {
            ...body,
            trigger: trigger === "regenerate-message" ? "regenerate" : "submit",
            text: last?.role === "user" ? messageText(last) : "",
            question: messages.filter((message) => message.role === "user").length,
          },
        };
      },
    }),
    [],
  );
  const { pinned, unpin } = useAssistant();
  const pageChanged = () => Promise.all([utils.books.invalidate(), utils.chapters.invalidate(), utils.notes.invalidate(), utils.folders.invalidate()]);
  const { messages, sendMessage, regenerate, status, error, stop, addToolApprovalResponse, setMessages } = useChat<StoredChatMessage>({
    transport,
    messages: open?.messages,
    // A Run or Cancel on a card is the whole request: nothing is typed, the response is sent as it lands
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    // The page beside the panel shows what the answer did — a rename, a move, a new note or
    // folder — only if it reads again; the thread does not know which tool ran
    onFinish: () => {
      void utils.chats.list.invalidate();
      void pageChanged();
    },
  });
  const busy = status === "submitted" || status === "streaming" || watching;
  const shown = watching && open ? open.messages : messages;

  // Messages that were here when the thread mounted: their cards are checked against the book
  // before being offered again, and their navigations are not followed a second time
  const [restoredIds] = useState(() => new Set((open?.messages ?? []).map((m) => m.id)));
  const followed = useRef(new Set((open?.messages ?? []).flatMap((m) => m.parts.map(toolPartOf).flatMap((p) => (p?.toolName === NAVIGATION ? [p.toolCallId] : [])))));
  // Deliberately the window's own stream, not the watched transcript: a navigation belongs to
  // the window that asked. A second window following along sees "Opened the book" and stays put.
  useEffect(() => {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    for (const part of last.parts.map(toolPartOf)) {
      if (!part || part.toolName !== NAVIGATION || part.state !== "output-available" || followed.current.has(part.toolCallId)) continue;
      followed.current.add(part.toolCallId);
      const url = (part.output as { url?: unknown } | undefined)?.url;
      if (typeof url === "string") void navigate(url);
    }
  }, [messages, navigate]);

  const ask = async (text: string) => {
    const refs = attachments.refs;
    // Several files carry what they are meant to become, so the model never has to ask
    const intent = refs.length > 1 ? bundleSentence(bundle, refs.length) : "";
    const question = [text.trim() || (refs.length > 0 ? FILES_ONLY_TEXT : ""), intent].filter(Boolean).join(" ");
    if (!question || busy || attachments.uploading) return;
    setStartError(null);
    setStopped(false);
    let id = conversationId;
    if (!id) {
      try {
        const created = await create.mutateAsync({ scope });
        id = created.id;
        setConversationId(id);
        onCreated(id);
      } catch (err) {
        setStartError(err instanceof Error ? err.message : "Could not start the conversation");
        return;
      }
    }
    saveThread(profileId, id);
    setInput("");
    attachments.clear();
    const read = pinned ? { bookId: pinned.bookId, chapterIds: pinned.chapters?.map((c) => c.id) } : undefined;
    void sendMessage({ text: question }, { body: { conversationId: id, model: model || undefined, screen, staged: refs, read } });
  };

  // Files are dropped on the whole thread, not only the composer: the overlay says what a drop
  // will do, and a folder is refused for now — the library page scans folders, this does not
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(e.dataTransfer.items.length);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(null);
      // A folder is walked for its PDFs, as on the library page; the DataTransfer is dead after
      // the first await, so it is captured first
      const drop = captureDrop(e);
      void droppedPdfs(drop).then((files) => attachments.add(files));
    },
  };

  const retry = () => {
    if (!conversationId || busy) return;
    setStopped(false);
    void regenerate({ body: { conversationId, model: model || undefined, screen } });
  };

  const respond = (approvalId: string, approved: boolean) => {
    if (busy) return;
    setStopped(false);
    void addToolApprovalResponse({
      id: approvalId,
      approved,
      ...(approved ? {} : { reason: "Cancelled by the person" }),
      options: { body: { conversationId, model: model || undefined, screen } },
    });
  };

  // The reversing call runs on the server; the card then says Undone, here and after a reload
  const [undoError, setUndoError] = useState<string | null>(null);
  const undo = async (toolCallId: string) => {
    if (!conversationId || busy) return;
    setUndoError(null);
    const res = await fetch("/assistant/undo", { method: "POST", headers: { "content-type": "application/json", ...profileHeaders() }, body: JSON.stringify({ conversationId, toolCallId }) });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      setUndoError(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Could not undo");
      return;
    }
    setMessages((all) => all.map((m) => ({
      ...m,
      parts: m.parts.map((p) => {
        const tool = toolPartOf(p);
        return tool && tool.toolCallId === toolCallId ? { ...p, output: { ...(tool.output as Record<string, unknown>), undone: true } } : p;
      }) as StoredChatMessage["parts"],
    })));
    void pageChanged();
  };

  const halt = async () => {
    if (!conversationId) return;
    setStopped(true);
    await stopRun.mutateAsync({ id: conversationId }).catch(() => {});
    stop();
  };

  // Follows the newest line while the reader is at the bottom, and stays put once they scroll up
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const lastAnswer = [...shown].reverse().find((m) => m.role === "assistant");
  const requestError = errorText(error);

  const closed = open?.closed ?? null;
  const canSend = !busy && !closed && !attachments.uploading && (input.trim() !== "" || attachments.refs.length > 0);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...dropProps} data-testid="assistant-thread">
      {dropping !== null && (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-(--accent) bg-(--bg-page)/90 text-sm text-(--accent-text)" data-testid="assistant-drop-overlay">
          <IconUpload className="h-6 w-6" />
          Drop to add {dropping === 1 ? "a PDF or a folder" : `${dropping} PDFs`}
        </div>
      )}
      {pdfPreview && <PdfPreviewModal fileId={pdfPreview.fileId} page={pdfPreview.page} filename={pdfPreview.filename} onClose={() => setPdfPreview(null)} />}
      <div
        ref={scroller}
        onScroll={(e) => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_WITHIN_PX; }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4"
        data-testid="assistant-transcript"
      >
        {open && (open.removedBookIds?.length ?? 0) > 0 && (
          <p className="rounded-lg border border-dashed border-(--border-input) px-3 py-2 text-xs text-(--text-muted)" data-testid="assistant-removed-notice">
            {open.removedBookIds?.length === 1 ? "A book this thread cited" : `${open.removedBookIds?.length} books this thread cited`} {open.removedBookIds?.length === 1 ? "was" : "were"} removed from the library; those links no longer open.
          </p>
        )}
        {shown.length === 0 && !watching && (
          screen.bookId
            ? <NextStepCard key={screen.bookId} bookId={screen.bookId} onAsk={ask} disabled={busy} presets={!pinned} />
            : (
              <div className="space-y-3" data-testid="assistant-welcome">
                <p className="text-sm text-(--text-secondary)">Ask how the app works, what to do next with a book, or which voice to pick. Drop a PDF here and it will look at it and offer to add it. It can search your library and act on it: anything that changes a book or costs credit is shown as a card first.</p>
                <div className="flex flex-col items-start gap-1.5">
                  {LIBRARY_QUESTIONS.map((q) => <Suggestion key={q} text={q} onAsk={ask} disabled={busy} />)}
                </div>
              </div>
            )
        )}
        {shown.map((message, i) => {
          if (message.role === "user") {
            return (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-(--accent) px-3 py-2 text-sm text-(--on-accent)" data-testid="assistant-question">{questionText(messageText(message))}</div>
              </div>
            );
          }
          const isLast = message === lastAnswer;
          const stored = message.metadata?.status;
          // A live answer that ended with neither words nor a call: the server keeps it as failed
          // (chat-run.ts), but the stream carried "complete" from its first byte, so the parts
          // are the only evidence here — and a kept answer with none is never marked complete
          const empty = isLast && !busy && !message.parts.some((p) => (p.type === "text" && p.text.trim() !== "") || toolPartOf(p));
          const ended = isLast && !busy
            ? (stored === "stopped" || (stopped && !stored) ? "stopped" : stored === "failed" || requestError || empty ? "failed" : null)
            : (stored === "stopped" || stored === "failed" ? stored : null);
          const asked = shown.slice(0, i).reverse().find((m) => m.role === "user");
          return <Answer key={message.id ?? i} message={message} question={asked ? questionText(messageText(asked)) : ""} live={isLast} busy={busy} restored={restoredIds.has(message.id)} ended={ended} error={message.metadata?.error ?? requestError ?? (empty ? EMPTY_ANSWER : null)} onRetry={isLast ? retry : null} onRespond={respond} onUndo={(id) => void undo(id)} onOpenPdf={setPdfPreview} />;
        })}
        {watching && (
          <p className="flex items-center gap-2 text-xs text-(--text-muted)" data-testid="assistant-watching">
            <IconSearch className="h-3 w-3 animate-pulse" />
            Being answered in another window. This follows along.
          </p>
        )}
        {undoError && <p className="text-xs text-(--danger-text)">{undoError}</p>}
        {requestError && !lastAnswer && (
          <div className="flex items-center gap-2 text-xs text-(--danger-text)" data-testid="assistant-request-error">
            <IconFailed className="h-3 w-3" />
            <span className="min-w-0 flex-1">{requestError}</span>
            <Button size="sm" onClick={retry} disabled={busy}><IconRerun className="h-3 w-3" />Retry</Button>
          </div>
        )}
        {startError && <p className="text-xs text-(--danger-text)">{startError}</p>}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); void ask(input); }}
        className="shrink-0 border-t border-(--border) bg-(--bg-card) p-3"
        data-testid="assistant-composer"
      >
        {pinned && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="assistant-pinned">
            <span className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md bg-(--bg-subtle) pl-2 text-xs text-(--text-secondary)" title={pinnedLabel(pinned)}>
              <IconBook className="h-3 w-3 shrink-0" />
              <span className="truncate">{pinnedLabel(pinned)}</span>
              <Button variant="icon" size="sm" onClick={unpin} aria-label="Unpin" title="Unpin — questions go back to searching" data-testid="assistant-unpin"><IconClose className="h-3 w-3" /></Button>
            </span>
            <span className="text-xs text-(--text-muted)">Read it:</span>
            {AI_PRESETS.map((preset) => (
              <Suggestion key={preset.key} text={preset.label} send={preset.prompt(pinned.chapters ? (pinned.chapters.length === 1 ? "chapter" : "chapters") : "book")} onAsk={ask} disabled={busy} />
            ))}
          </div>
        )}
        <StagedChips chips={attachments.chips} onRemove={attachments.remove} onMove={attachments.move} />
        {attachments.chips.length > 1 && <BundleChoice value={bundle} onChange={setBundle} count={attachments.chips.length} />}
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => { attachments.add([...(e.target.files ?? [])]); e.target.value = ""; }}
            data-testid="assistant-file-input"
          />
          <Button variant="icon" size="sm" onClick={() => fileInput.current?.click()} aria-label="Attach PDFs" title="Attach PDFs" disabled={busy}>
            <IconAttach className="h-4 w-4" />
          </Button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
            placeholder={closed ?? (attachments.chips.length > 0 ? "Say what to do with them, or just send…" : screen.bookId ? "Ask about this book…" : "Ask how it works, or drop a PDF…")}
            disabled={!!closed}
            title={closed ?? undefined}
            rows={1}
            className="min-h-9 max-h-32 min-w-0 flex-1 resize-none rounded-md border border-(--border-input) bg-(--bg-input) px-2.5 py-2 text-sm text-(--text-primary)"
            data-testid="assistant-input"
          />
          {busy ? (
            <Button variant="icon" size="sm" onClick={() => void halt()} aria-label="Stop the answer" data-testid="assistant-stop"><IconStop className="h-4 w-4" /></Button>
          ) : (
            <Button variant="primary" square size="sm" type="submit" disabled={!canSend} aria-label="Send" title={attachments.uploading ? "Waiting for the upload to finish" : "Send"} data-testid="assistant-send"><IconSend className="h-4 w-4" /></Button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-(--text-faint)">
          <ModelPicker value={model} onChange={setModel} requireTools testId="assistant-model" placement="above" />
          <span className="truncate">Enter sends · Shift+Enter for a new line</span>
        </div>
      </form>
    </div>
  );
}
