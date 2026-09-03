import { useCallback, useRef, useState } from "react";

// A callback ref rather than a ref object, because the element it measures is usually behind a
// loading branch: an effect keyed on a ref object runs once, finds current === null, and never
// observes anything, leaving the width pinned at 0 and every consumer on the narrow layout.
// Reader.tsx works around that by hand with a hasManifest dependency; this cannot.
export function useElementWidth(): { measure: (node: HTMLElement | null) => void; width: number } {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const measure = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const next = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    next.observe(node);
    observer.current = next;
  }, []);

  return { measure, width };
}
