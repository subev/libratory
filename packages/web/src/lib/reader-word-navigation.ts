import { useCallback, useMemo, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { BilingualDocument, BilingualSide } from "../../../server/src/lib/bilingual-format.ts";

function address(target: EventTarget): { side: BilingualSide; token: number; element: HTMLButtonElement } | null {
  if (!(target instanceof HTMLButtonElement)) return null;
  const [side, value] = target.dataset.token?.split(":") ?? [];
  if (side !== "source" && side !== "target") return null;
  const token = Number(value);
  return Number.isInteger(token) ? { side, token, element: target } : null;
}

export function useWordNavigation(doc: BilingualDocument) {
  const [chosen, setChosen] = useState({ source: doc.source.tokens[0]?.id ?? null, target: doc.target.tokens[0]?.id ?? null });
  const stops = useMemo(() => {
    const stop = (side: BilingualSide) => {
      const token = doc[side].tokens.find((token) => token.id === chosen[side]) ?? doc[side].tokens[0];
      const pair = token ? doc.pairs.find((pair) => {
        const range = pair[side];
        return range && token.range[0] >= range[0] && token.range[1] <= range[1];
      }) : null;
      return { token: token?.id ?? null, pair };
    };
    return { source: stop("source"), target: stop("target") };
  }, [chosen, doc]);
  const onFocusCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const at = address(event.target);
    if (at) setChosen((old) => old[at.side] === at.token ? old : { ...old, [at.side]: at.token });
  }, []);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const at = address(event.target);
    if (!at) return;
    const tokens = doc[at.side].tokens;
    const index = tokens.findIndex((token) => token.id === at.token);
    if (index < 0) return;
    const rtl = getComputedStyle(at.element).direction === "rtl";
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = index + (rtl ? -1 : 1); break;
      case "ArrowLeft": next = index + (rtl ? 1 : -1); break;
      case "Home": next = 0; break;
      case "End": next = tokens.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const token = tokens[Math.max(0, Math.min(next, tokens.length - 1))];
    if (token) event.currentTarget.querySelector<HTMLButtonElement>(`[data-token="${at.side}:${token.id}"]`)?.focus();
  }, [doc]);
  return { stops, onFocusCapture, onKeyDown };
}
