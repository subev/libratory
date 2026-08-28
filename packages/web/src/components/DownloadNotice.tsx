import type { ReactNode } from "react";

// The card that offers an optional download and then gets out of the way. Three features need it
// — the model bundles, Pocket's per-language models, and the page renderer — and when each had its
// own copy the two rendered side by side in the voice picker drifted apart.
export function DownloadNotice({
  className = "",
  children,
  buttonLabel,
  downloading,
  progress,
  disabled,
  error,
  settledLabel,
  onDownload,
  testIdPrefix,
}: {
  className?: string;
  children: ReactNode;
  buttonLabel: string;
  downloading: boolean;
  progress?: string | null;
  disabled?: boolean;
  error?: string | null;
  settledLabel: string;
  onDownload: () => void;
  testIdPrefix: string;
}) {
  return (
    <div
      className={`rounded-md border border-(--border) bg-(--bg-subtle) px-3 py-2 text-xs space-y-1 ${className}`}
      data-testid={`${testIdPrefix}-notice`}
    >
      {children}
      {error && <p className="text-(--danger-text)" data-testid={`${testIdPrefix}-error`}>{error}</p>}
      <button
        type="button"
        onClick={onDownload}
        disabled={downloading || disabled}
        className="px-2 py-1 rounded bg-(--accent) text-(--on-accent) disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
        data-testid={`${testIdPrefix}-download`}
      >
        {downloading ? `Downloading ${settledLabel}… ${progress ?? ""}`.trimEnd() : buttonLabel}
      </button>
      {downloading && (
        <p className="text-(--text-muted)">Keep using the app — this unlocks itself when it lands, no restart.</p>
      )}
    </div>
  );
}
