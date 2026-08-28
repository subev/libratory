// The bridge packages/desktop/src/preload.cjs exposes on window. There is no shell in a browser,
// so every member is optional and every call site has to cope with its absence.
export type UpdateProgress = { percent: number; transferred: number; total: number };

declare global {
  interface Window {
    setup?: {
      report?: (details: string) => void;
      // null when the download ends — downloaded, cancelled or failed — so the bar can clear itself
      // without needing an event of its own.
      onUpdateProgress?: (fn: (progress: UpdateProgress | null) => void) => void;
    };
  }
}
