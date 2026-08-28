import { useEffect, useState } from "react";
import { describeDownload } from "../lib/update-progress.ts";
import type { UpdateProgress as Progress } from "../lib/shell.ts";

// A 190 MB download used to happen behind a dismissed dialog, reported only to the Dock tile and a
// log file — which is indistinguishable from nothing happening. This is the visible half.
export function UpdateProgress() {
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    window.setup?.onUpdateProgress?.(setProgress);
  }, []);

  if (!progress) return null;
  const { fraction, percent, label } = describeDownload(progress);

  return (
    <div
      className="fixed bottom-4 left-4 z-50 w-72 rounded-lg border border-(--border) bg-(--bg-card) px-3 py-2 shadow-lg"
      role="status"
      data-testid="update-progress"
    >
      <p className="text-xs font-medium text-(--text-primary)">Downloading the new Libratory</p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-(--bg-subtle)">
        <div
          className="h-full rounded-full bg-blue-600 transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-(--text-muted) tabular-nums">{label}</p>
      <p className="mt-1 text-[11px] text-(--text-faint)">
        Keep working — it installs when you quit, and nothing in your library changes.
      </p>
      <span className="sr-only">{`${percent}% downloaded`}</span>
      <progress className="sr-only" value={fraction} max={1} />
    </div>
  );
}
