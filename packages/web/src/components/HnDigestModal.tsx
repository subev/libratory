import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "../trpc.ts";
import { getStoredProfileId } from "../lib/profile.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { IconChat, IconArrowRight } from "./icons.tsx";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type PreviewStory = { id: string; ymd: string; points: number; comments: number; title: string; url: string };

// A preview answers one set of parameters; changing them makes it a misdescription of what Build
// would create, so it is held against the parameters it answered and read as absent once they move.
type Preview = { key: string; stories: PreviewStory[] | null; error: string | null; excluded: ReadonlySet<string> };

const NONE_EXCLUDED: ReadonlySet<string> = new Set();

function storyDayLabel(ymd: string): string {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function HnDigestModal({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [perDay, setPerDay] = useState(false);
  const [count, setCount] = useState(10);
  const [folder, setFolder] = useState("hackernews-summaries");
  const [synthesize, setSynthesize] = useState(true);
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [bookId, setBookId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loaded, setLoaded] = useState<Preview | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const previewKey = `${from}|${to}|${count}|${perDay}`;
  const current = loaded?.key === previewKey ? loaded : null;
  const preview = current?.stories ?? null;
  const previewError = current?.error ?? null;
  const excluded = current?.excluded ?? NONE_EXCLUDED;

  useEffect(() => () => sourceRef.current?.close(), []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  function run() {
    if (state === "running") return;
    setLines([]);
    setBookId(null);
    setState("running");
    const params = new URLSearchParams({
      from,
      to,
      count: String(count),
      perDay: perDay ? "1" : "0",
      synthesize: synthesize ? "1" : "0",
      ...(excluded.size > 0 ? { exclude: [...excluded].join(",") } : {}),
      ...(folder.trim() ? { folder: folder.trim() } : {}),
      ...(getStoredProfileId() ? { profile: getStoredProfileId()! } : {}),
    });
    const source = new EventSource(`/scripts/hn-top10/stream?${params}`);
    sourceRef.current = source;
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as { type: string; text?: string; code?: number };
      if (event.type === "line" && event.text) {
        setLines((prev) => [...prev, event.text!]);
        const match = event.text.match(/\/books\/([0-9a-f-]{36})/);
        if (match?.[1]) setBookId(match[1]);
      } else if (event.type === "exit") {
        source.close();
        setState(event.code === 0 ? "done" : "failed");
        utils.books.list.invalidate();
        utils.folders.list.invalidate();
      } else if (event.type === "error") {
        source.close();
        setLines((prev) => [...prev, event.text ?? "Failed"]);
        setState("failed");
      }
    };
    source.onerror = () => {
      source.close();
      setState((s) => (s === "running" ? "failed" : s));
    };
  }

  async function previewStories() {
    if (previewLoading || state === "running") return;
    const key = previewKey;
    setPreviewLoading(true);
    setLoaded(null);
    try {
      const params = new URLSearchParams({ from, to, count: String(count), perDay: perDay ? "1" : "0" });
      const res = await fetch(`/scripts/hn-top10/preview?${params}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setLoaded({ key, stories: (await res.json()) as PreviewStory[], error: null, excluded: NONE_EXCLUDED });
    } catch (err) {
      setLoaded({ key, stories: null, error: err instanceof Error ? err.message : "Preview failed", excluded: NONE_EXCLUDED });
    } finally {
      setPreviewLoading(false);
    }
  }

  const includedCount = preview ? preview.length - excluded.size : null;

  return (
    <Modal size="md" onClose={onClose} testId="hn-digest-modal">
      <ModalHeader title="Hacker News daily digest" onClose={onClose} />

      <div className="p-4 space-y-3 overflow-y-auto">
        <p className="text-xs text-(--text-muted)">
          Builds a podcast-style book from the top stories on hckrnews.com — one chapter per story,
          with the community's take capped at the end. Pick a single day or a range to catch up:
          a range takes the overall top stories across it, or the top of each day.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-(--text-secondary)">
            From
            <input
              type="date"
              value={from}
              max={todayIso()}
              onChange={(e) => {
                setFrom(e.target.value);
                if (e.target.value > to) setTo(e.target.value);
                if (e.target.value === to) setPerDay(false);
              }}
              disabled={state === "running"}
              className="mt-1 block px-2 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-sm text-(--text-primary)"
              data-testid="hn-digest-from"
            />
          </label>
          <label className="text-xs text-(--text-secondary)">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={todayIso()}
              onChange={(e) => {
                setTo(e.target.value);
                if (e.target.value === from) setPerDay(false);
              }}
              disabled={state === "running"}
              className="mt-1 block px-2 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-sm text-(--text-primary)"
              data-testid="hn-digest-to"
            />
          </label>
          <label className="text-xs text-(--text-secondary)">
            Stories
            <input
              type="number"
              min={1}
              max={30}
              value={count}
              onChange={(e) => setCount(Number(e.target.value) || 10)}
              disabled={state === "running"}
              className="mt-1 block w-20 px-2 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-sm text-(--text-primary)"
            />
          </label>
          <label className="text-xs text-(--text-secondary) flex-1 min-w-40">
            Folder
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={state === "running"}
              placeholder="(library root)"
              className="mt-1 block w-full px-2 py-1.5 rounded-md border border-(--border) bg-(--bg-card) text-sm text-(--text-primary)"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-(--text-secondary) pb-2">
            <input
              type="checkbox"
              checked={synthesize}
              onChange={(e) => setSynthesize(e.target.checked)}
              disabled={state === "running"}
              className="rounded"
            />
            Synthesize audio right away
          </label>
        </div>
        <fieldset className="flex flex-wrap gap-4 text-xs text-(--text-secondary)" data-testid="hn-digest-mode">
          <label className={`flex items-center gap-1.5 ${from === to ? "opacity-50" : ""}`}>
            <input
              type="radio"
              name="hn-digest-mode"
              checked={!perDay}
              onChange={() => setPerDay(false)}
              disabled={state === "running" || from === to}
            />
            Overall top {count} across the range ({count} chapters)
          </label>
          <label className={`flex items-center gap-1.5 ${from === to ? "opacity-50" : ""}`}>
            <input
              type="radio"
              name="hn-digest-mode"
              checked={perDay}
              onChange={() => setPerDay(true)}
              disabled={state === "running" || from === to}
              data-testid="hn-digest-per-day"
            />
            Top {count} of <em>each</em> day, in day order
            {from !== to && (() => {
              const estimate = count * (Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1);
              return (
                <span
                  className={estimate > 60 ? "text-(--warning-text) font-medium" : "text-(--text-faint)"}
                  title={estimate > 60 ? "Each chapter is one AI summary plus TTS — a build this size runs for hours" : undefined}
                >
                  (~{estimate} chapters{estimate > 60 ? " — hours of build time" : ""})
                </span>
              );
            })()}
          </label>
          {from === to && <span className="text-(--text-faint) self-center">— pick a range to unlock modes</span>}
        </fieldset>

        {previewError && <p className="text-xs text-(--danger-text)">{previewError}</p>}
        {preview && (
          <div className="rounded-md border border-(--border) divide-y divide-(--border) max-h-72 overflow-y-auto" data-testid="hn-digest-preview">
            {preview.map((story) => (
              <div key={story.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={!excluded.has(story.id)}
                  onChange={() =>
                    setLoaded((prev) => {
                      if (!prev) return prev;
                      const next = new Set(prev.excluded);
                      if (next.has(story.id)) next.delete(story.id);
                      else next.add(story.id);
                      return { ...prev, excluded: next };
                    })
                  }
                  disabled={state === "running"}
                  className="rounded shrink-0"
                  title="Uncheck to leave this story out of the book"
                />
                {from !== to && (
                  <span className="w-11 shrink-0 text-(--text-faint)">{storyDayLabel(story.ymd)}</span>
                )}
                <span className="w-10 shrink-0 text-right tabular-nums text-(--text-muted)" title={`${story.comments} comments`}>
                  {story.points}
                </span>
                <a
                  href={story.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex-1 truncate hover:underline ${excluded.has(story.id) ? "text-(--text-faint) line-through" : "text-(--accent-text)"}`}
                  title={story.url}
                >
                  {story.title}
                </a>
                <a
                  href={`https://news.ycombinator.com/item?id=${story.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 shrink-0 text-(--text-faint) hover:text-(--text-secondary)"
                  title={`${story.comments} comments on Hacker News`}
                >
                  <IconChat className="h-3 w-3" /> {story.comments}
                </a>
              </div>
            ))}
            {preview.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-(--text-muted)">No stories found for this range.</p>
            )}
          </div>
        )}
        {lines.length > 0 && (
          <div
            ref={logRef}
            className="h-56 overflow-y-auto rounded-md border border-(--border) bg-(--bg-subtle) p-2 font-mono text-[11px] leading-relaxed text-(--text-secondary) whitespace-pre-wrap"
            data-testid="hn-digest-log"
          >
            {lines.join("\n")}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 px-4 py-3 border-t border-(--border) shrink-0">
        <button
          onClick={previewStories}
          disabled={previewLoading || state === "running"}
          className="px-3 py-1.5 rounded-md text-xs font-medium border border-(--border) text-(--text-secondary) hover:bg-(--bg-subtle) disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="hn-digest-preview-btn"
        >
          {previewLoading ? "Fetching stories…" : preview ? "Refresh preview" : "Preview stories"}
        </button>
        <button
          onClick={run}
          disabled={state === "running" || includedCount === 0}
          title={includedCount === 0 ? "Every story is unchecked" : undefined}
          className="px-3 py-1.5 bg-(--accent) text-(--on-accent) rounded-md text-xs font-medium hover:bg-(--accent-hover) disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="hn-digest-run"
        >
          {state === "running"
            ? "Building…"
            : `Build book${includedCount !== null ? ` (${includedCount} chapter${includedCount === 1 ? "" : "s"})` : ""}`}
        </button>
        {state === "running" && (
          <span className="text-xs text-(--text-muted)">
            Summarizing — takes a few minutes. Closing this window won't stop it.
          </span>
        )}
        {state === "done" && bookId && (
          <Link
            to={`/books/${bookId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-(--accent-text) hover:text-(--accent-text-hover)"
            data-testid="hn-digest-open"
          >
            Open the book <IconArrowRight className="h-3 w-3" />
          </Link>
        )}
        {state === "failed" && <span className="text-xs text-(--danger-text)">Failed — see the log above</span>}
      </div>
    </Modal>
  );
}
