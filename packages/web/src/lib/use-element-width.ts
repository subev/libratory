import { useCallback, useEffect, useRef } from "react";

// A callback ref rather than a ref object, because the element it measures is usually behind a
// loading branch: an effect keyed on a ref object runs once, finds current === null, and never
// observes anything, leaving the width pinned at 0 and every consumer on the narrow layout.
// Reports the width rather than holding it, so the caller decides what a change is worth.
export function useElementWidth(onWidth: (width: number) => void): (node: HTMLElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null);
  // Kept in a ref so `measure` stays identity-stable and does not re-observe on every render; the
  // assignment is in an effect because a ref may not be written during render.
  const latest = useRef(onWidth);
  useEffect(() => {
    latest.current = onWidth;
  });

  return useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    // Seeded before the observer fires, or the first painted frame is the narrowest layout and
    // every column and label pops in a frame later.
    latest.current(node.getBoundingClientRect().width);
    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) latest.current(entry.contentRect.width);
    });
    next.observe(node);
    observer.current = next;
  }, []);
}
