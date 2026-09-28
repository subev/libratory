import { useEffect, useRef, useState, type ReactNode, type PointerEvent, type FocusEvent } from "react";
import { createPortal } from "react-dom";
import type { BilingualSide } from "../../../../server/src/lib/bilingual-format.ts";

type Selection = { pair: string; side: BilingualSide; token: number; anchor: HTMLElement };
type Address = Omit<Selection, "anchor">;

export function useWordMeaning() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const tooltip = useRef<HTMLDivElement | null>(null);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const cancelHold = () => { if (holdTimer.current) clearTimeout(holdTimer.current); };
  const dismiss = () => { cancelClose(); cancelHold(); setSelection(null); };
  const show = (address: Address, anchor: HTMLElement) => { cancelClose(); setSelection({ ...address, anchor }); };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setSelection(null), 180); };

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);
  useEffect(() => {
    if (!selection) return;
    const close = () => setSelection(null);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !selection.anchor.contains(event.target) && !tooltip.current?.contains(event.target)) close();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [selection]);

  return {
    selection, show, dismiss, cancelClose, scheduleClose,
    setTooltip: (node: HTMLDivElement | null) => { tooltip.current = node; },
    consumeHold: () => { const value = held.current; held.current = false; return value; },
    handlers: (address: Address) => ({
      onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => { if (event.pointerType === "mouse") show(address, event.currentTarget); },
      onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => { cancelHold(); if (event.pointerType !== "touch") scheduleClose(); },
      onFocus: (event: FocusEvent<HTMLButtonElement>) => { if (event.currentTarget.matches(":focus-visible")) show(address, event.currentTarget); },
      onBlur: scheduleClose,
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        cancelHold(); held.current = false;
        if (event.pointerType !== "touch") return;
        origin.current = { x: event.clientX, y: event.clientY };
        const anchor = event.currentTarget;
        holdTimer.current = setTimeout(() => { held.current = true; show(address, anchor); }, 450);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === "touch" && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10) dismiss();
      },
      onPointerUp: cancelHold,
      onPointerCancel: dismiss,
      onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => { if (held.current) event.preventDefault(); },
    }),
  };
}

export function WordMeaning({ meaning, children }: { meaning: ReturnType<typeof useWordMeaning>; children: ReactNode }) {
  const selection = meaning.selection;
  if (!selection) return null;
  return createPortal(
    <div id="word-meaning" role="tooltip" ref={(node) => {
      meaning.setTooltip(node);
      if (!node) return;
      const anchor = selection.anchor.getBoundingClientRect(), box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - 8))}px`;
      const toolbar = selection.anchor.closest('[data-testid="bilingual-reader"]')?.querySelector('[data-testid="bilingual-toolbar"]');
      const clearTop = Math.max(8, (toolbar?.getBoundingClientRect().bottom ?? 0) + 8);
      const above = anchor.top - box.height - 8;
      const top = above >= clearTop ? above : anchor.bottom + 8;
      node.style.top = `${Math.max(8, Math.min(top, window.innerHeight - box.height - 8))}px`;
    }}
      className="fixed z-50 max-w-xs space-y-1 rounded-lg border border-(--border) bg-(--bg-card) px-4 py-3 text-(--text-primary) shadow-lg"
      style={{ maxWidth: "calc(100vw - 16px)" }}
      onPointerEnter={meaning.cancelClose} onPointerLeave={meaning.scheduleClose}
    >{children}</div>, document.body,
  );
}
