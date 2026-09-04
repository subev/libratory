import { useEffect, useRef, useState } from "react";
import { filesSummary, formatOutputDate, formatDuration, formatSize, formatTag } from "../lib/format.ts";
import { SPEEDS, loadSpeed, saveSpeed, subscribeSpeed } from "../lib/playback-speed.ts";
import { useAudioTime } from "../lib/use-audio-time.ts";
import { Button } from "./Button.tsx";
import { IconDelete, IconDownload, IconPause, IconPlay } from "./icons.tsx";
import { FormatTag, ResourceGroup, ResourceRow } from "./book/ResourceRow.tsx";
import { useShellLayout } from "./book/BookShell.tsx";

export type AssemblyRow = {
  id: string;
  outputPath: string;
  durationMs: number;
  chapterCount: number;
  chapterSummary: string;
  sizeBytes: number | null;
  createdAt: string | Date;
};

export function AudioOutputsSection({
  assemblies,
  latestOutputPath,
  onDelete,
  isDeleting,
}: {
  assemblies: AssemblyRow[];
  latestOutputPath: string | null;
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  // One speed for the list, not one per row: it is the reader's stored preference, and a row that
  // read it at mount would still show 1x after another row — or the chapter modal over this very
  // page, which never unmounts it — changed it.
  const [speed, setSpeed] = useState(loadSpeed);
  useEffect(() => subscribeSpeed(setSpeed), []);

  return (
    <ResourceGroup
      title="Audio only"
      description="Plain narration with chapter marks — plays in any audiobook app, in the car, or on a watch. BookPlayer is a good free one."
      count={assemblies.length === 0 ? "nothing assembled yet" : filesSummary(assemblies)}
    >
      {assemblies.map((assembly) => (
        <AssemblyRowItem
          key={assembly.id}
          assembly={assembly}
          isLatest={assembly.outputPath === latestOutputPath}
          speed={speed}
          onSpeed={(rate) => {
            setSpeed(rate);
            saveSpeed(rate);
          }}
          onDelete={onDelete}
          isDeleting={isDeleting}
        />
      ))}
    </ResourceGroup>
  );
}

// A native <audio controls> is a browser widget in the middle of a designed row: it brings its own
// grey chrome, spans the whole width and pushes the row's own actions to the far edge. The row's
// leading tile is the transport instead, over a hidden element — which installExclusiveAudio still
// pauses when anything else starts.
function AssemblyRowItem({
  assembly,
  isLatest,
  speed,
  onSpeed,
  onDelete,
  isDeleting,
}: {
  assembly: AssemblyRow;
  isLatest: boolean;
  speed: number;
  onSpeed: (rate: number) => void;
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  // Loading a resource resets playbackRate to defaultPlaybackRate, so both have to be set
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
  }, [speed]);

  const filename = assembly.outputPath.split("/").pop();
  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setFailed(false);
    void (audio.paused ? audio.play().catch(() => setFailed(true)) : audio.pause());
  };

  return (
    <ResourceRow
      testId="assembly-row"
      active={playing}
      onIconClick={toggle}
      iconLabel={playing ? `Pause ${filename}` : `Play ${filename}`}
      icon={playing ? <IconPause weight="fill" className="h-3.5 w-3.5" /> : <IconPlay className="h-3.5 w-3.5" />}
      title={filename}
      tag={<FormatTag>{formatTag(filename)}</FormatTag>}
      subtitle={
        <>
          {formatDuration(assembly.durationMs)} ·{" "}
          <span title={assembly.chapterSummary}>
            {assembly.chapterCount} chapter mark{assembly.chapterCount === 1 ? "" : "s"}
          </span>{" "}
          · {formatOutputDate(assembly.createdAt)}
        </>
      }
      trailing={
        failed ? (
          <span
            className="text-xs text-(--danger-text) truncate"
            title="This file will not play — it may have been moved or deleted on disk"
            data-testid="assembly-error"
          >
            Will not play
          </span>
        ) : (
          <AssemblyTransport
            audioRef={audioRef}
            playing={playing}
            totalMs={assembly.durationMs}
            label={`Position in ${filename}`}
            speed={speed}
            onSpeed={onSpeed}
          />
        )
      }
      badge={
        isLatest ? (
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-(--success-bg) text-(--success-text)">latest</span>
        ) : undefined
      }
      size={formatSize(assembly.sizeBytes)}
      actions={
        <>
          {/* No type attribute: assemblies are m4b since 2026-08-19 but older ones are mp3, and a
              single source declaring the wrong one is a source the browser may skip. The route sends
              the real Content-Type, which is the only thing that knows. */}
          <audio
            ref={audioRef}
            hidden
            preload="none"
            src={`/audio/assembly/${assembly.id}`}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setFailed(true)}
          />
          <Button
            variant="icon"
            size="sm"
            href={`/download/assembly/${assembly.id}`}
            download={filename}
            aria-label={`Download ${filename}`}
            title="Download"
            data-testid="assembly-download"
          >
            <IconDownload className="h-4 w-4" />
          </Button>
          <Button
            variant="danger"
            soft
            square
            size="sm"
            onClick={() => {
              if (confirm("Delete this assembly?")) onDelete(assembly.id);
            }}
            disabled={isDeleting}
            aria-label={`Delete ${filename}`}
            title="Delete"
          >
            <IconDelete className="h-4 w-4" />
          </Button>
        </>
      }
    />
  );
}

// Its own state, so the playhead's ticks re-render the transport and not the whole row
function AssemblyTransport({
  audioRef,
  playing,
  totalMs,
  label,
  speed,
  onSpeed,
}: {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  playing: boolean;
  totalMs: number;
  label: string;
  speed: number;
  onSpeed: (rate: number) => void;
}) {
  const [ms, setMs] = useState(0);
  const { trayCompact } = useShellLayout();
  useAudioTime(audioRef, playing, setMs);

  // The position stays where the file ended, so reaching the end does not pull the transport out
  // from under whoever was scrubbing towards it
  if (!playing && ms === 0) return null;

  const seek = (to: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = to / 1000;
    setMs(to);
  };

  return (
    <span className="flex items-center gap-2 shrink-0" data-testid="assembly-transport">
      <span className="text-xs tabular-nums text-(--text-secondary)">{formatDuration(ms)}</span>
      {/* Narrow, the scrub would take the filename's last legible inch */}
      {!trayCompact && <Scrub atMs={ms} totalMs={totalMs} onSeek={seek} label={label} />}
      <span className="text-xs tabular-nums text-(--text-faint)">−{formatDuration(Math.max(0, totalMs - ms))}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1)}
        title="Playback speed"
        className="tabular-nums"
        data-testid="assembly-speed"
      >
        {speed}x
      </Button>
    </span>
  );
}

const STEP_MS = 10_000;

function Scrub({
  atMs,
  totalMs,
  onSeek,
  label,
}: {
  atMs: number;
  totalMs: number;
  onSeek: (ms: number) => void;
  label: string;
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const played = totalMs > 0 ? Math.min(1, Math.max(0, atMs / totalMs)) : 0;

  const seekTo = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * totalMs);
  };

  return (
    <span
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(totalMs / 1000)}
      aria-valuenow={Math.round(atMs / 1000)}
      aria-valuetext={formatDuration(atMs)}
      title="Drag to scrub"
      onPointerDown={(event) => {
        // Without this the drag paints a text selection across the row behind the track — but
        // cancelling pointerdown also cancels the focus that comes with it, and the arrow keys
        // below are only reachable focused.
        event.preventDefault();
        seekTo(event.clientX);
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seekTo(event.clientX);
      }}
      onKeyDown={(event) => {
        const to =
          event.key === "ArrowLeft" ? atMs - STEP_MS
          : event.key === "ArrowRight" ? atMs + STEP_MS
          : event.key === "Home" ? 0
          : event.key === "End" ? totalMs
          : null;
        if (to === null) return;
        event.preventDefault();
        onSeek(Math.min(totalMs, Math.max(0, to)));
      }}
      className="relative flex items-center w-32 h-3.5 cursor-pointer touch-none"
      data-testid="assembly-scrub"
    >
      <span className="absolute inset-x-0 h-[3px] rounded-full bg-(--bg-subtle)" />
      <span className="absolute left-0 h-[3px] rounded-full bg-(--accent)" style={{ width: `${played * 100}%` }} />
      <span className="absolute h-[9px] w-[9px] -translate-x-1/2 rounded-full bg-(--accent)" style={{ left: `${played * 100}%` }} />
    </span>
  );
}
