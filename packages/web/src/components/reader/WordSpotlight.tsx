import { useCallback, useEffect, useLayoutEffect, useState } from "react";

type Lamp = { x: number; y: number; w: number; h: number; glide: boolean };

// The narrated word is one lamp that travels along the line rather than a highlight that blinks
// from word to word. Sliding is only true within a line — a wrap is a jump, so it lands there.
export function WordSpotlight({ containerRef, at }: { containerRef: React.RefObject<HTMLElement | null>; at: string }) {
  const [lamp, setLamp] = useState<Lamp | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const word = container?.querySelector('[data-testid="reader-word"]');
    // No word is lit in the pause between two of them; the lamp waits where it is rather than
    // blinking out and hard-landing on the next one. The caller unmounts it when the sentence ends.
    if (!container || !word) return;

    const rect = word.getBoundingClientRect();
    const frame = container.getBoundingClientRect();
    const next = {
      x: rect.left - frame.left - container.clientLeft + container.scrollLeft,
      y: rect.top - frame.top - container.clientTop + container.scrollTop,
      w: rect.width,
      h: rect.height,
    };
    setLamp((previous) => ({ ...next, glide: previous !== null && Math.abs(previous.y - next.y) < next.h / 2 }));
  }, [containerRef]);

  useLayoutEffect(measure, [measure, at]);

  // Reflow moves every word after it, and the lamp has to land on the new line, not the old place
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, measure]);

  if (!lamp) return null;

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 rounded-sm bg-(--accent)/60 motion-reduce:transition-none"
      style={{
        transform: `translate(${lamp.x}px, ${lamp.y}px)`,
        width: lamp.w,
        height: lamp.h,
        transition: lamp.glide ? "transform 130ms ease-out, width 130ms ease-out" : "none",
      }}
    />
  );
}
