// The bridge packages/desktop/src/preload.cjs exposes on window. There is no shell in a browser,
// so every member is optional and every call site has to cope with its absence.
export type UpdateProgress = { percent: number; transferred: number; total: number };
// A file the shell was asked to open, claimed once: the reader pulls rather than being pushed at,
// because the page it lands on is lazy and may not have mounted when the navigation finishes.
export type OpenedFile = { name: string; bytes: Uint8Array };

declare global {
  interface Window {
    setup?: {
      report?: (details: string) => void;
      // null when the download ends — downloaded, cancelled or failed — so the bar can clear itself
      // without needing an event of its own.
      onUpdateProgress?: (fn: (progress: UpdateProgress | null) => void) => void;
      // Resolves null when nothing is waiting, which is every launch that did not come from Finder.
      takeOpenFile?: () => Promise<OpenedFile | null>;
    };
  }
}
