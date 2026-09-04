export type DocumentFormat = "pdf" | "epub" | "epub-sync";

export function documentFormatLabel(format: DocumentFormat): string {
  return format === "epub-sync" ? "Synced EPUB" : format.toUpperCase();
}

export function pendingExportLabel(pending: { running: boolean; waiting: boolean }): string {
  return pending.waiting ? "waiting for chapters" : pending.running ? "rendering" : "queued";
}

// A queued export carries its own copy setting, which the checkbox no longer speaks for
export function pendingExportSummary(
  pending: { format: DocumentFormat; running: boolean; waiting: boolean; copyToDropDir: boolean },
): string {
  const copy = pending.format === "epub-sync" && pending.copyToDropDir ? " + copy to import folder" : "";
  return `${documentFormatLabel(pending.format)} ${pendingExportLabel(pending)}${copy}`;
}

export function formatOutputDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function formatSize(bytes: number | null): string | undefined {
  return bytes === null ? undefined : formatBytes(bytes);
}

// A row whose file is missing contributes nothing rather than making the total unreadable.
export function filesSummary(rows: { sizeBytes: number | null }[]): string {
  const total = formatBytes(rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0));
  return `${rows.length} file${rows.length === 1 ? "" : "s"} · ${total}`;
}

export function formatRelativeTime(date: string | Date): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

export function formatLogTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
