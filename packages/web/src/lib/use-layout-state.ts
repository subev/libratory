import { useCallback, useState } from "react";
import { useElementWidth } from "./use-element-width.ts";

// Publishing the raw width would push ~60 identical values a second through a context during a
// resize drag, and a context change walks straight past the children-identity bailout that would
// otherwise protect the tables reading it. So the *layout* is the state, and an unchanged one is
// not published at all.
export function sameFlags<T extends Record<string, string | number | boolean>>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((key) => a[key] === b[key]);
}

export function useLayoutState<T extends Record<string, string | number | boolean>>(
  compute: (width: number) => T,
): [T, (node: HTMLElement | null) => void] {
  const [layout, setLayout] = useState(() => compute(0));
  const onWidth = useCallback(
    (next: number) => {
      setLayout((prev) => {
        const candidate = compute(next);
        return sameFlags(prev, candidate) ? prev : candidate;
      });
    },
    [compute],
  );
  return [layout, useElementWidth(onWidth)];
}
