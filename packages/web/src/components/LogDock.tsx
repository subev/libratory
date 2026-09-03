import { useState, useEffect, useRef } from "react";
import { trpc } from "../trpc.ts";
import { formatLogTime } from "../lib/format.ts";
import { useBodyScrollLock } from "../lib/use-body-scroll-lock.ts";
import { IconChevronUp, IconClose } from "./icons.tsx";

// Docked above the app's modals (z-50) so activity stays visible while they're open
export function LogDock({ bookId, isProcessing, files }: { bookId: string; isProcessing: boolean; files?: { index: number; filename: string }[] }) {
  const [open, setOpen] = useState(false);
  const [fileFilter, setFileFilter] = useState<string>("");
  useBodyScrollLock(open);
  const utils = trpc.useUtils();
  const isMultiFile = files && files.length > 1;

  // Also while there is nothing to show: a job that is queued but not yet picked up has not
  // touched the book, so isProcessing is still false, and the dock would stay hidden until a
  // reload — for the whole first run on a cold worker.
  const { data: logs = [] } = trpc.books.logs.useQuery(
    { bookId },
    { refetchInterval: (query) => (isProcessing || (query.state.data?.length ?? 0) === 0 ? 1000 : false) }
  );

  const clearLogs = trpc.books.clearLogs.useMutation({
    onSuccess: () => utils.books.logs.invalidate({ bookId }),
  });

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // The bar is a flex child of the book shell now, not a fixed overlay: two pinned bars cannot both
  // own the bottom of the window. It keeps its height when there is nothing to say, because
  // appearing and disappearing would shift the scroll pane by 36px whenever a job starts.
  const idle = logs.length === 0 && !isProcessing;

  const lastEntry = logs[logs.length - 1];
  const filteredLogs = fileFilter
    ? logs.filter((entry) => entry.fileIndex === Number(fileFilter))
    : logs;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="log-dock"
        disabled={idle}
        className="w-full flex items-center gap-3 px-4 h-9 bg-(--bg-terminal) text-left font-mono text-xs text-(--terminal-text) border-t border-(--terminal-border) enabled:hover:bg-(--bg-terminal-hover) enabled:cursor-pointer"
        title={idle ? "Nothing has happened on this book yet" : "Open logs"}
      >
        <span className="flex items-center gap-1.5 shrink-0 text-(--terminal-dim) font-sans font-medium">
          <span className={`w-2 h-2 rounded-full ${isProcessing ? "bg-(--success) animate-pulse" : "bg-(--terminal-dim)"}`} />
          Logs ({logs.length})
        </span>
        {lastEntry ? (
          <span className="truncate min-w-0 flex-1">
            <span className="text-(--terminal-dim) mr-2 select-none">{formatLogTime(String(lastEntry.createdAt))}</span>
            {lastEntry.message}
          </span>
        ) : (
          <span className="text-(--terminal-dim) flex-1">Waiting for logs...</span>
        )}
        <span className="shrink-0 text-(--terminal-dim)"><IconChevronUp className="h-3 w-3" /></span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-(--scrim)"
          onClick={() => setOpen(false)}
          data-testid="log-modal"
        >
          <div
            className="bg-(--bg-terminal) rounded-lg shadow-xl w-full max-w-3xl h-[70vh] mx-4 flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-(--terminal-border) shrink-0">
              <span className="flex items-center gap-1.5 text-sm font-medium text-(--terminal-text)">
                <span className={`w-2 h-2 rounded-full ${isProcessing ? "bg-(--success) animate-pulse" : "bg-(--terminal-dim)"}`} />
                Logs ({filteredLogs.length}{fileFilter ? ` / ${logs.length}` : ""})
              </span>
              {isMultiFile && (
                <select
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  className="text-xs px-2 py-0.5 border border-(--terminal-border) rounded bg-(--bg-terminal-hover) text-(--terminal-text)"
                >
                  <option value="">All files</option>
                  {files!.map((f) => (
                    <option key={f.index} value={String(f.index)}>
                      {f.index + 1}. {f.filename}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex-1" />
              {logs.length > 0 && (
                <button
                  onClick={() => clearLogs.mutate({ bookId })}
                  className="text-xs text-(--terminal-dim) hover:text-(--terminal-danger)"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="text-(--terminal-dim) hover:text-(--terminal-text) text-lg leading-none px-1"
                title="Close (Esc)"
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <LogScroller logs={filteredLogs} />
          </div>
        </div>
      )}
    </>
  );
}

function LogScroller({ logs }: { logs: { id: string; message: string; createdAt: string | Date }[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    if (!shouldAutoScroll.current || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    shouldAutoScroll.current = atBottom;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-5"
    >
      {logs.length === 0 ? (
        <p className="text-(--terminal-dim)">Waiting for logs...</p>
      ) : (
        logs.map((entry) => (
          <div key={entry.id} className="flex gap-3">
            <span className="text-(--terminal-dim) shrink-0 select-none">
              {formatLogTime(String(entry.createdAt))}
            </span>
            <span className="text-(--terminal-text) whitespace-pre-wrap break-all">
              <LogMessageText message={entry.message} />
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function LogMessageText({ message }: { message: string }) {
  const parts = message.split(/(\/files\/\S+)/g);

  return parts.map((part, index) => {
    if (!part.startsWith("/files/")) {
      return <span key={index}>{part}</span>;
    }

    return (
      <a
        key={index}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-(--accent-text) underline decoration-(--accent)/40 underline-offset-2 hover:text-(--accent-text-hover)"
      >
        {part}
      </a>
    );
  });
}
