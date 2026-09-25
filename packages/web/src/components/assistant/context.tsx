import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { loadPanelOpen, savePanelOpen } from "../../lib/assistant-prefs.ts";

// Text a page hands the panel to be read whole — the Ask AI buttons: the book, or chapters of
// it. It stays pinned under the composer, every question carries it, until it is unpinned.
export type PinnedText = { bookId: string; bookTitle: string | null; chapters: { id: string; title: string }[] | null };

// Open or collapsed is one fact shared by the panel and every toolbar button that toggles it;
// the pinned text is the other, because the page that pins it is not the panel that shows it
type AssistantState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  pinned: PinnedText | null;
  pin: (text: PinnedText) => void;
  unpin: () => void;
};

const AssistantContext = createContext<AssistantState>({ open: false, setOpen: () => {}, toggle: () => {}, pinned: null, pin: () => {}, unpin: () => {} });

export function useAssistant(): AssistantState {
  return useContext(AssistantContext);
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(loadPanelOpen);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    savePanelOpen(next);
  }, []);
  const toggle = useCallback(() => setOpenState((current) => {
    savePanelOpen(!current);
    return !current;
  }), []);
  const [pinned, setPinned] = useState<PinnedText | null>(null);
  // Pinning opens the panel: the button that pins is the person asking to see it
  const pin = useCallback((text: PinnedText) => {
    setPinned(text);
    setOpen(true);
  }, [setOpen]);
  const unpin = useCallback(() => setPinned(null), []);
  const value = useMemo(() => ({ open, setOpen, toggle, pinned, pin, unpin }), [open, setOpen, toggle, pinned, pin, unpin]);
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}
