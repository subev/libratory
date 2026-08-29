import { useState } from "react";
import { trpc } from "../trpc.ts";
import { formatBytes } from "../lib/format.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { IconDisk } from "./icons.tsx";

export function DiskUsageButton({ bookId }: { bookId: string }) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: usage } = trpc.books.diskUsage.useQuery(
    { bookId },
    { staleTime: 30_000, refetchOnWindowFocus: false },
  );

  const cleanupMutation = trpc.books.cleanupChunks.useMutation({
    onSuccess: () => utils.books.diskUsage.invalidate({ bookId }),
  });

  const rows: { label: string; bytes: number; hint?: string }[] = usage
    ? [
        { label: "Source PDFs", bytes: usage.uploads },
        { label: "Extraction cache", bytes: usage.extractionCache, hint: "Marker JSON in data/tmp — needed for re-detect, structure view, and proposals" },
        { label: "Chapter audio", bytes: usage.chapterAudio, hint: "Original and translated chapter audio files" },
        { label: "WAV chunks", bytes: usage.chunkWavs, hint: "Per-chunk synthesis output — only needed to resume unfinished chapters and for chunk previews" },
        { label: "Assemblies", bytes: usage.assemblies },
        { label: "Documents", bytes: usage.documents },
        ...(usage.other > 0 ? [{ label: "Other (in-flight scratch)", bytes: usage.other }] : []),
      ]
    : [];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Disk space used by this book — click for a breakdown and cleanup"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-(--border-input) bg-(--bg-card) text-sm font-medium text-(--text-secondary) shadow-sm hover:bg-(--bg-subtle) tabular-nums"
        data-testid="disk-usage"
      >
        <IconDisk className="w-4 h-4 text-(--text-muted)" />
        {usage ? formatBytes(usage.total) : "..."}
      </button>

      {open && (
        <Modal size="sm" onClose={() => setOpen(false)} backdropTestId="disk-usage-modal">
          <ModalHeader title="Disk usage" onClose={() => setOpen(false)} />
          <div className="p-5 overflow-y-auto">
            {!usage ? (
              <p className="text-sm text-(--text-muted)">Measuring...</p>
            ) : (
              <>
                <ul className="divide-y divide-(--divide) mb-4">
                  {rows.map((row) => (
                    <li key={row.label} className="py-2 flex items-baseline justify-between gap-3" title={row.hint}>
                      <span className="text-sm text-(--text-secondary)">{row.label}</span>
                      <span className="text-sm tabular-nums text-(--text-tertiary)">{formatBytes(row.bytes)}</span>
                    </li>
                  ))}
                  <li className="py-2 flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-(--text-primary)">Total</span>
                    <span className="text-sm font-semibold tabular-nums text-(--text-primary)">{formatBytes(usage.total)}</span>
                  </li>
                </ul>

                <button
                  onClick={() => cleanupMutation.mutate({ bookId })}
                  disabled={usage.cleanableChunkWavs === 0 || cleanupMutation.isPending}
                  title={
                    usage.cleanableChunkWavs === 0
                      ? "No finished chapters have leftover WAV chunks"
                      : "Delete the WAV chunks of chapters whose audio is done — chapters, text, and audio files are kept. Chunks of unfinished chapters stay so they can resume."
                  }
                  className="w-full px-4 py-2 bg-(--bg-subtle) text-(--text-secondary) rounded-md text-sm font-medium hover:bg-(--border) disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="cleanup-chunks"
                >
                  {cleanupMutation.isPending
                    ? "Cleaning up..."
                    : `Delete WAV chunks of finished chapters (frees ${formatBytes(usage.cleanableChunkWavs)})`}
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
