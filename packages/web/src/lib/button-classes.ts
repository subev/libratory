// Shared so a toolbar restyle is one edit rather than nine, and so the voice trigger keeps matching
// the buttons it sits beside. Follows the class-constant convention of ACTION_PILL in ChapterTable.
export const TOOLBAR_BUTTON =
  "text-xs px-2.5 py-1 rounded bg-(--bg-card) border border-(--border) text-(--text-secondary) hover:bg-(--bg-subtle) font-medium disabled:opacity-30 disabled:cursor-not-allowed";

// One accent-filled action per section; everything beside it takes SECONDARY_BUTTON. Focus comes
// from the base :focus-visible rule in styles.css, so neither carries a ring.
export const PRIMARY_BUTTON =
  "px-4 py-2 bg-(--accent) text-(--on-accent) rounded-md text-sm font-medium hover:bg-(--accent-hover) disabled:opacity-50 disabled:cursor-not-allowed";

export const SECONDARY_BUTTON =
  "px-4 py-2 rounded-md border border-(--border-input) bg-(--bg-card) text-(--text-secondary) text-sm font-medium hover:text-(--text-primary) hover:bg-(--bg-card-hover) disabled:opacity-50 disabled:cursor-not-allowed";

export const DANGER_BUTTON =
  "px-4 py-2 bg-(--danger) text-(--on-danger) rounded-md text-sm font-medium hover:bg-(--danger-hover) disabled:opacity-50 disabled:cursor-not-allowed";
