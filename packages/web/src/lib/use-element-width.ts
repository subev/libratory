import { useLayoutEffect, useRef, useState } from "react";

// The node arrives as state rather than a ref object, because the element it measures is usually
// behind a loading branch: an effect keyed on a ref object runs once, finds current === null, and
// never observes anything, leaving the width pinned at 0 and every consumer on the narrow layout.
// Reports the width rather than holding it, so the caller decides what a change is worth.
export function useElementWidth(onWidth: (width: number) => void): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  // Declared first so the seed below never reports through a callback a render out of date
  const latest = useRef(onWidth);
  useLayoutEffect(() => {
    latest.current = onWidth;
  });

  useLayoutEffect(() => {
    if (!node) return;
    // Seeded before the observer fires, or the first painted frame is the narrowest layout and
    // every column and label pops in a frame later.
    latest.current(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) latest.current(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return setNode;
}
