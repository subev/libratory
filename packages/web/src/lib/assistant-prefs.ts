// The panel's two per-browser conveniences: whether it is open, and which thread it was on.
// Neither is state the server needs — the thread itself lives in chat_conversations.
const OPEN_KEY = "assistant.open";
const THREAD_KEY = "assistant.thread";
const WIDTH_KEY = "assistant.width";

// The designed width, and the range a drag may take it through: narrower and the cards wrap
// every field, wider and the page beside it drops below its own tightest layout on a laptop
export const DEFAULT_PANEL_WIDTH = 392;
export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 720;

export function clampPanelWidth(width: number, windowWidth: number): number {
  // Never more than half the window: the page it sits beside has to stay usable
  const max = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.floor(windowWidth / 2)));
  return Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, width)));
}

export function loadPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_PANEL_WIDTH ? Math.min(MAX_PANEL_WIDTH, stored) : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

export function savePanelWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Storage unavailable: the designed width next time
  }
}

// A thread older than this is not reopened: whatever it was about is over
export const THREAD_TTL_MS = 24 * 60 * 60 * 1000;

export function loadPanelOpen(): boolean {
  try {
    const stored = localStorage.getItem(OPEN_KEY);
    // Open on first launch, as designed: the panel is how a newcomer learns the loop
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}

export function savePanelOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private windows and blocked storage: the panel simply starts open next time
  }
}

export type StoredThread = { id: string; at: number };

// A thread belongs to one profile, so each profile remembers its own
const threadKey = (profileId: string) => `${THREAD_KEY}.${profileId}`;

export function loadThread(profileId: string, now = Date.now()): StoredThread | null {
  try {
    const raw = localStorage.getItem(threadKey(profileId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { id, at } = parsed as Partial<StoredThread>;
    if (typeof id !== "string" || typeof at !== "number") return null;
    return now - at > THREAD_TTL_MS ? null : { id, at };
  } catch {
    return null;
  }
}

export function saveThread(profileId: string, id: string, at = Date.now()) {
  try {
    localStorage.setItem(threadKey(profileId), JSON.stringify({ id, at }));
  } catch {
    // Storage unavailable: the next opening starts a new thread
  }
}

export function clearThread(profileId: string) {
  try {
    localStorage.removeItem(threadKey(profileId));
  } catch {
    // Nothing to clear
  }
}
