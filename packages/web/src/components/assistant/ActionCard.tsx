import { useState } from "react";
import type { DynamicToolUIPart } from "ai";
import { trpc } from "../../trpc.ts";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { actionOf, bookIdOf, doneLabel, fieldsOf } from "../../lib/assistant-actions.ts";
import { tierOf, undoOf, type AssistantToolName } from "../../../../server/src/lib/assistant-tiers.ts";
import { Button } from "../Button.tsx";
import { IconCheck, IconFailed, IconRerun, IconSpinner, IconStopped, IconWarning } from "../icons.tsx";

// A tool call as the panel draws it: the SDK's part with the name lifted out, so a static tool
// (`tool-<name>`) and a dynamic one read the same; the states are the SDK's own
export type ToolPart = {
  toolName: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

function BookName({ id }: { id: string }) {
  const { data } = trpc.books.get.useQuery({ id }, { staleTime: 60_000 });
  return <>{data?.title ?? "…"}</>;
}

// The note analyze_text made: the answer itself, kept on the book, with the one thing a note can
// become — a chapter, so a summary or a "did you know" can be narrated
function NoteResult({ noteId, answer }: { noteId: string; answer: string }) {
  const [added, setAdded] = useState(false);
  const utils = trpc.useUtils();
  // The chapter table beside the panel shows the new row only if the book is read again
  const toChapter = trpc.notes.toChapter.useMutation({
    onSuccess: () => {
      setAdded(true);
      void utils.books.invalidate();
      void utils.chapters.invalidate();
    },
  });
  return (
    <div className="mt-2 space-y-2" data-testid="assistant-note">
      <div className="max-h-96 overflow-y-auto rounded-md bg-(--bg-reading) p-3">
        <MarkdownBlock>{answer}</MarkdownBlock>
      </div>
      <div className="flex items-center gap-2 text-xs text-(--text-muted)">
        <span>Saved to the book's notes.</span>
        {added ? (
          <span className="text-(--success-text)">Added as a chapter</span>
        ) : (
          <Button size="sm" onClick={() => toChapter.mutate({ id: noteId })} disabled={toChapter.isPending} title="Append this note as a suspended chapter, to narrate">
            Add as chapter
          </Button>
        )}
        {toChapter.error && <span className="text-(--danger-text)">{toChapter.error.message}</span>}
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "waiting" | "done" | "off" | "spend"; children: React.ReactNode }) {
  const skin = {
    waiting: "bg-(--accent-subtle) text-(--accent-text)",
    done: "bg-(--success-bg) text-(--success-text)",
    off: "bg-(--bg-subtle) text-(--text-muted)",
    spend: "bg-(--warning-bg) text-(--warning-text)",
  }[tone];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${skin}`}>{children}</span>;
}

// A tool call that changes something, as the panel shows it: waiting for Run, running, done,
// cancelled, failed — and for a small edit that ran on its own, Done with Undo. `live` is whether
// the card belongs to the newest answer: only there can Run, Cancel or Undo still mean anything.
// A card restored after a reload is checked against the book before it is offered again: one
// whose book changed since it was made — chapters extracted by hand, a voice picked in the app —
// is out of date, and the person asks for a fresh one rather than running a stale plan
function useStale(check: boolean, bookId: string | null, offeredAt: string | null): boolean {
  const { data } = trpc.books.get.useQuery({ id: bookId ?? "" }, { enabled: check && !!bookId && !!offeredAt, staleTime: 0 });
  if (!check || !data || !offeredAt) return false;
  return new Date(data.updatedAt).getTime() > new Date(offeredAt).getTime();
}

export function ActionCard({ part, live, busy, restored, offeredAt, onRespond, onUndo }: {
  part: ToolPart;
  live: boolean;
  busy: boolean;
  // Loaded from the server at mount rather than streamed in this session
  restored: boolean;
  offeredAt: string | null;
  onRespond: (approvalId: string, approved: boolean) => void;
  onUndo: (toolCallId: string) => void;
}) {
  const tool = part.toolName as AssistantToolName;
  const input = (part.input ?? {}) as Record<string, unknown>;
  const tier = tierOf(tool, input);
  const action = actionOf(tool);
  const fields = fieldsOf(tool, input);
  const bookId = bookIdOf(input);
  const output = part.output as { undone?: boolean; error?: string } | undefined;
  const undo = undoOf(part.output);
  const stale = useStale(restored && live && part.state === "approval-requested", bookId, offeredAt);

  const quick = tier === "quick";
  const title = quick && part.state === "output-available" ? doneLabel(tool, input) : action.label;

  let badge: React.ReactNode;
  let footer: React.ReactNode = null;
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      badge = <Badge tone="waiting">Preparing</Badge>;
      break;
    case "approval-requested":
      if (stale) {
        badge = <Badge tone="off">Out of date</Badge>;
        footer = <p className="text-xs text-(--text-muted)">The book changed after this was offered. Ask again for a fresh card.</p>;
        break;
      }
      badge = live ? <Badge tone={tier === "spend" ? "spend" : "waiting"}>Needs your OK</Badge> : <Badge tone="off">Not run</Badge>;
      footer = live ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => part.approval && onRespond(part.approval.id, true)} disabled={busy || !part.approval} data-testid="assistant-card-run">Run</Button>
          <Button size="sm" onClick={() => part.approval && onRespond(part.approval.id, false)} disabled={busy || !part.approval} data-testid="assistant-card-cancel">Cancel</Button>
        </div>
      ) : null;
      break;
    case "approval-responded":
      if (part.approval?.approved) badge = <Badge tone="waiting"><IconSpinner className="mr-1 inline h-3 w-3 animate-spin" />Running</Badge>;
      else badge = <Badge tone="off">{part.approval?.reason?.startsWith("Not run") ? "Not run" : "Cancelled"}</Badge>;
      break;
    case "output-denied":
      badge = <Badge tone="off">{part.approval?.reason?.startsWith("Not run") ? "Not run" : "Cancelled"}</Badge>;
      break;
    case "output-available":
      badge = output?.undone ? <Badge tone="off">Undone</Badge> : <Badge tone="done"><IconCheck className="mr-1 inline h-3 w-3" />Done</Badge>;
      if (quick && undo && !output?.undone && live) {
        footer = (
          <Button size="sm" onClick={() => onUndo(part.toolCallId)} disabled={busy} data-testid="assistant-card-undo">
            <IconRerun className="h-3 w-3" />
            Undo
          </Button>
        );
      }
      break;
    case "output-error":
      badge = <Badge tone="off"><IconFailed className="mr-1 inline h-3 w-3" />Failed</Badge>;
      footer = <p className="text-xs text-(--danger-text)">{part.errorText ?? "The action failed."}</p>;
      break;
    default:
      badge = <Badge tone="off"><IconStopped className="mr-1 inline h-3 w-3" />{part.state}</Badge>;
  }

  return (
    <div className={`rounded-md border p-3 ${part.state === "approval-requested" && live ? "border-(--accent)" : "border-(--border)"} bg-(--bg-card)`} data-testid={`assistant-card-${part.state}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-(--text-primary)">{title}</span>
        {badge}
      </div>
      {(bookId || fields.length > 0) && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {bookId && (
            <>
              <dt className="text-(--text-muted)">Book</dt>
              <dd className="min-w-0 truncate text-(--text-primary)"><BookName id={bookId} /></dd>
            </>
          )}
          {fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-(--text-muted)">{f.label}</dt>
              <dd className="min-w-0 wrap-break-word text-(--text-primary)">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!quick && action.note && part.state === "approval-requested" && !stale && <p className="mt-2 text-xs text-(--text-muted)">{action.note}</p>}
      {tier === "spend" && part.state === "approval-requested" && !stale && (
        <p className="mt-1 flex items-center gap-1 text-xs text-(--warning-text)"><IconWarning className="h-3 w-3" />This spends credit or downloads a large file.</p>
      )}
      {tool === "analyze_text" && part.state === "output-available" && typeof (part.output as { noteId?: unknown })?.noteId === "string" && typeof (part.output as { answer?: unknown }).answer === "string" && (
        <NoteResult noteId={(part.output as { noteId: string }).noteId} answer={(part.output as { answer: string }).answer} />
      )}
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  );
}
