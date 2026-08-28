import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { CueTranscript } from "../components/reader/CueTranscript.tsx";
import { CuePages } from "../components/reader/CuePages.tsx";
import { bodyFit, chapterPages, UNMAPPED, type ReaderCues, type ReaderManifest } from "../lib/reader-doc.ts";
import { httpSource, type DocumentSource } from "../lib/reader-source.ts";
import { formatDuration } from "../lib/format.ts";
import { useFollowCue, type FollowBand } from "../lib/cue-follow.ts";
import { useAudioTime } from "../lib/use-audio-time.ts";
import { usePlayPauseKey } from "../lib/play-pause-key.ts";
import { SPEEDS, loadSpeed, saveSpeed } from "../lib/playback-speed.ts";

// The band a cue may start in without the page moving: clear of the sticky bar, clear of the fold
const READER_BAND: FollowBand = { top: 120, bottom: 140, landing: 0.3 };

// Logical widths of a current iPhone, which is the screen the page has to survive
const WIDTHS = [
  { id: "full", label: "Full", px: null },
  { id: "phone", label: "Phone", px: 393 },
  { id: "phone-landscape", label: "Phone ↻", px: 852 },
] as const;

const VIEWS = [
  { id: "column", label: "Column", hint: "Pages cropped to their columns — the real type, minus the margins" },
  { id: "page", label: "Page", hint: "The whole page, for figures and tables" },
  { id: "text", label: "Text", hint: "The spoken text reflowed at your own size" },
] as const;

type View = (typeof VIEWS)[number]["id"];

const GRANULARITY_HINT: Record<ReaderCues["granularity"], string> = {
  word: "Every word is timed by the engine that spoke it",
  sentence: "Sentence timings where the engine reported words, whole chunks elsewhere",
  chunk: "This audio predates word timings — a highlight covers a whole synthesis chunk",
};

// Below this the book's own type is too small at the chosen width, and the reader says so
const LEGIBLE_PERCENT = 70;

// How often an un-narrated chapter asks whether it has been narrated since
const NARRATION_POLL_MS = 10_000;

const WARN_BANNER = "mb-3 rounded border border-(--warning) bg-(--warning-bg) px-3 py-2 text-sm text-(--warning-text)";
const NOTE_BANNER = "mb-3 rounded border border-(--border) bg-(--bg-subtle) px-3 py-2 text-sm text-(--text-muted)";

// The route the library links to. A container opened from disk renders the same reader with a
// different source and no book to go back to.
export function Reader() {
  const { id } = useParams<{ id: string }>();
  const source = useMemo(() => (id ? httpSource(id) : null), [id]);
  if (!source) return null;
  return <ReaderFor source={source} bookId={id} live />;
}

export function ReaderFor({ source, bookId, live = false }: { source: DocumentSource; bookId?: string; live?: boolean }) {
  const id = bookId;
  const [searchParams, setSearchParams] = useSearchParams();
  const [manifest, setManifest] = useState<ReaderManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(loadSpeed);
  const [chosenView, setChosenView] = useState<View>("column");
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["id"]>("full");
  const [debug, setDebug] = useState({ rects: false, layout: false });

  const audioRef = useRef<HTMLAudioElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    source.manifest().then(setManifest).catch((err: Error) => setError(err.message));
  }, [source]);

  const requested = searchParams.get("chapter");
  const list = manifest?.chapters ?? [];
  // A chapter nobody has narrated still opens on its pages, but a narrated one is the better landing
  const chapter =
    (requested === null ? undefined : list.find((entry) => entry.i === Number(requested))) ??
    list.find((entry) => entry.audio) ??
    list[0] ??
    null;

  const chapterId = chapter?.id ?? null;
  const chapterAudio = chapter?.audio ?? null;
  const pageStart = chapter?.pageStart ?? null;
  const pageEnd = chapter?.pageEnd ?? null;

  const pages = useMemo(
    () => (manifest ? chapterPages(manifest, { pageStart, pageEnd }) : []),
    [manifest, pageStart, pageEnd],
  );

  // The pages come from the PDF, so they are there long before a word is spoken. Only a chapter
  // with no pages at all has to fall back to the reflowed text, and it does so without overwriting
  // the choice the reader made, which comes back on the next chapter that has pages.
  const view: View = pages.length === 0 ? "text" : chosenView;

  // Both the cues and the playhead belong to one chapter. They carry the chapter they were loaded
  // or measured for, so a chapter change reads as empty during render rather than through an
  // effect that would show the last chapter's highlight for a frame.
  const cueUrl = chapterAudio && chapter?.cues ? chapter.cues : null;
  const [loaded, setLoaded] = useState<{ url: string; cues: ReaderCues | null; error: string | null } | null>(null);
  const cues = loaded && loaded.url === cueUrl ? loaded.cues : null;
  const cueError = loaded && loaded.url === cueUrl ? loaded.error : null;

  const [played, setPlayed] = useState<{ chapterId: string | null; ms: number }>({ chapterId: null, ms: 0 });
  const ms = played.chapterId === chapterId ? played.ms : 0;
  const setMs = useCallback((at: number) => setPlayed({ chapterId, ms: at }), [chapterId]);

  useEffect(() => {
    if (!cueUrl) return;
    let live = true;
    source
      .cues(cueUrl)
      .then((next) => { if (live) setLoaded({ url: cueUrl, cues: next, error: null }); })
      // A chapter's own failure, not the reader's — the picker has to stay usable
      .catch((err: Error) => { if (live) setLoaded({ url: cueUrl, cues: null, error: err.message }); });
    return () => { live = false; };
  }, [source, cueUrl]);

  // The reader holds no database row by design, so a chapter narrated while it is open can only be
  // noticed by asking the manifest again — while there is something to wait for, and someone looking
  useEffect(() => {
    if (!live || chapterId === null || chapterAudio) return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      source.manifest().then(setManifest).catch(() => {});
    };
    const timer = setInterval(check, NARRATION_POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [live, source, chapterId, chapterAudio]);

  useAudioTime(audioRef, playing, setMs);

  // Loading a resource resets playbackRate to defaultPlaybackRate, so setting only the former
  // drops the reader back to 1x on every chapter change and every reload, with the picker still
  // claiming otherwise. Setting both is what makes the preference survive the load.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
  }, [speed, chapterAudio]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio?.src) return false;
    void (audio.paused ? audio.play().catch(() => {}) : audio.pause());
    return true;
  }, []);
  usePlayPauseKey(togglePlay);

  // Rolling on to the next narrated chapter, audiobook-style: the flag survives the chapter
  // swap and the new audio element plays itself once it has metadata
  const autoPlay = useRef(false);
  const next = chapter ? list.find((entry) => entry.i > chapter.i && entry.audio) : undefined;

  const goToChapter = (to: number, play: boolean) => {
    autoPlay.current = play;
    setSearchParams({ chapter: String(to) });
  };

  // Picking a sentence is a request to hear it, so a paused reader starts speaking
  const seek = (to: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = to / 1000;
    setMs(to);
    if (audio.paused) audio.play().catch(() => {});
  };

  // Switching chapter or view relays the whole document out — a column is not where its page was —
  // so the place being read has to be found again rather than left where the old scroll lands
  useFollowCue(cues, ms, READER_BAND, `${chapter?.id ?? ""}:${view}`);

  // Measured rather than read off a ref during render, which is a frame behind on the first paint
  // and never notices the window being resized
  const [pagesWidth, setPagesWidth] = useState(0);
  // The host only exists once the manifest has rendered the page frame
  const hasManifest = manifest !== null;
  useEffect(() => {
    const host = pagesRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setPagesWidth(entry.contentRect.width); });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hasManifest]);

  const fit = useMemo(() => {
    // What the reader is actually looking at: a column in column view, the whole page otherwise
    const first = pages[0];
    const cropWidth = (view === "column" ? first?.columns[0]?.[2] : first?.w) ?? 0;
    const rendered = width === "full" ? pagesWidth : WIDTHS.find((w) => w.id === width)!.px!;
    return bodyFit(manifest?.book.medianBodyPt ?? null, cropWidth, rendered);
  }, [pages, view, width, pagesWidth, manifest?.book.medianBodyPt]);

  if (error) return <ReaderShell bookId={id}><p className="text-sm text-(--danger-text)">{error}</p></ReaderShell>;
  if (!manifest || !chapter) return <ReaderShell bookId={id}><p className="text-sm text-(--text-muted)">Loading…</p></ReaderShell>;

  const maxWidth = WIDTHS.find((w) => w.id === width)!.px;
  const hasPages = pages.length > 0;

  return (
    <ReaderShell bookId={id} chapterId={chapter.id} title={manifest.book.title}>
      <div className="sticky top-0 z-10 -mx-4 mb-4 border-b border-(--border) bg-(--bg-page)/95 px-4 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={togglePlay}
            disabled={!chapter.audio}
            title={chapter.audio ? (playing ? "Pause (space)" : "Play the narration (space)") : "This chapter has no audio yet"}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--accent) text-(--on-accent) hover:bg-(--accent-hover) disabled:opacity-40"
            data-testid="reader-play"
          >
            {playing ? "❚❚" : "▶"}
          </button>

          <select
            value={chapter.i}
            onChange={(event) => goToChapter(Number(event.target.value), false)}
            className="max-w-[16rem] rounded border border-(--border) bg-(--bg-input) px-2 py-1 text-sm"
            data-testid="reader-chapter"
          >
            {manifest.chapters.map((entry) => (
              <option key={entry.id} value={entry.i}>
                {entry.i + 1}. {entry.title}
              </option>
            ))}
          </select>

          <select
            value={speed}
            onChange={(event) => {
              const rate = Number(event.target.value);
              setSpeed(rate);
              saveSpeed(rate);
            }}
            title="Playback speed"
            data-testid="reader-speed"
            className="rounded border border-(--border) bg-(--bg-input) px-1 py-1 text-xs"
          >
            {SPEEDS.map((rate) => <option key={rate} value={rate}>{rate}x</option>)}
          </select>

          <span className="tabular-nums text-xs text-(--text-muted)">
            {formatDuration(ms)} / {formatDuration(cues?.totalMs ?? chapter.durationMs ?? 0)}
          </span>

          <Segmented
            options={VIEWS.map((entry) => ({ id: entry.id, label: entry.label, title: entry.hint }))}
            value={view}
            onChange={(next) => setChosenView(next as View)}
            testId="reader-view"
          />

          <Segmented
            options={WIDTHS.map((entry) => ({
              id: entry.id,
              label: entry.label,
              title: entry.px ? `Lay the pages out at ${entry.px} logical pixels — the width of a phone screen` : "Use the whole window",
            }))}
            value={width}
            onChange={(next) => setWidth(next as typeof width)}
            testId="reader-width"
          />

          <div className="ml-auto flex items-center gap-3 text-xs text-(--text-muted)">
            {cues && (
              <span
                className="rounded bg-(--bg-subtle) px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                title={GRANULARITY_HINT[cues.granularity]}
                data-testid="reader-granularity"
              >
                {cues.granularity}
              </span>
            )}
            {fit && view !== "text" && (
              <span
                className={fit.percent < LEGIBLE_PERCENT ? "text-(--warning-text)" : undefined}
                title={`This book's body type is ${manifest.book.medianBodyPt}pt and renders at ${fit.px.toFixed(1)}px here, against the ${17}px a phone reads comfortably`}
                data-testid="reader-fit"
              >
                {fit.px.toFixed(0)}px · {fit.percent}%
              </span>
            )}
            <label className="flex items-center gap-1" title="Draw every cue's rectangles, not just the one being spoken">
              <input type="checkbox" checked={debug.rects} onChange={(e) => setDebug({ ...debug, rects: e.target.checked })} />
              rects
            </label>
            <label className="flex items-center gap-1" title="Draw the content box and the detected columns">
              <input type="checkbox" checked={debug.layout} onChange={(e) => setDebug({ ...debug, layout: e.target.checked })} />
              layout
            </label>
          </div>
        </div>

      </div>

      {cueError && (
        <p className={WARN_BANNER} data-testid="reader-cue-error">
          {cueError} — the audio still plays, but nothing can be highlighted. Re-synthesizing this
          chapter writes one.
        </p>
      )}

      {chapter.mode === "text" && (
        <p
          className={hasPages ? NOTE_BANNER : WARN_BANNER}
          data-testid="reader-text-mode"
        >
          {UNMAPPED[chapter.why ?? "unmapped"]}{" "}
          {hasPages ? "Its pages are below, with nothing marked on them." : "It reads as text rather than on the page."}
        </p>
      )}

      {fit && fit.percent < LEGIBLE_PERCENT && view !== "text" && (
        <p className="mb-3 rounded border border-(--border) bg-(--bg-subtle) px-3 py-2 text-sm text-(--text-tertiary)" data-testid="reader-too-small">
          At this width the book's own type renders at {fit.px.toFixed(0)}px — around {fit.percent}% of
          comfortable. {view === "page" ? "Column view crops the margins away; text" : "Text"} view reflows it at your own size.
        </p>
      )}

      <audio
        ref={audioRef}
        src={source.resolve(chapter.audio)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          if (next) goToChapter(next.i, true);
        }}
        onLoadedMetadata={() => {
          if (!autoPlay.current) return;
          autoPlay.current = false;
          audioRef.current?.play().catch(() => {});
        }}
        onTimeUpdate={() => { if (!playing && audioRef.current) setMs(audioRef.current.currentTime * 1000); }}
        className="hidden"
      />

      <div ref={pagesRef} className="mx-auto flex flex-col gap-4" style={maxWidth ? { maxWidth } : { maxWidth: "48rem" }}>
        {view === "text" ? (
          <CueTranscript cues={cues} ms={ms} onSeek={seek} />
        ) : (
          <CuePages
            manifest={manifest}
            chapter={chapter}
            cues={cues}
            ms={ms}
            columns={view === "column"}
            onSeek={seek}
            debug={debug}
            resolve={source.resolve}
            empty="This chapter has no pages to show — switch to text view to read it."
          />
        )}
      </div>
    </ReaderShell>
  );
}

function Segmented({
  options,
  value,
  onChange,
  testId,
}: {
  options: { id: string; label: string; title: string }[];
  value: string;
  onChange: (id: string) => void;
  testId: string;
}) {
  return (
    <div className="flex rounded border border-(--border) bg-(--bg-card) p-0.5" data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          title={option.title}
          data-testid={`${testId}-${option.id}`}
          data-active={value === option.id}
          className={`rounded px-2 py-0.5 text-xs ${value === option.id ? "bg-(--accent) text-(--on-accent)" : "text-(--text-tertiary) hover:bg-(--bg-subtle)"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ReaderShell({ bookId, chapterId, title, children }: { bookId?: string; chapterId?: string; title?: string; children: React.ReactNode }) {
  // ?chapter=<id> is the book page's own deep link, so going back lands on the chapter you left
  const back = bookId ? `/books/${bookId}${chapterId ? `?chapter=${chapterId}` : ""}` : "/";
  return (
    <div className="min-h-screen bg-(--bg-page) px-4 py-3">
      <div className="mx-auto max-w-5xl">
        <nav className="mb-2 flex items-center gap-2 text-sm text-(--text-muted)">
          <Link to={back} className="text-(--accent) hover:text-(--accent-hover)" data-testid="reader-back">
            ← Back
          </Link>
          {title && <span className="truncate text-(--text-secondary)">{title}</span>}
        </nav>
        {children}
      </div>
    </div>
  );
}
