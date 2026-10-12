import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTopmostEscape } from "./Modal.tsx";

const GAP = 6;

// Fixed coordinates for the panel, measured from the trigger. The chosen side flips when the panel
// would run off the viewport on the requested one and fits on the other.
function placePanel(
  trigger: DOMRect,
  panel: { width: number; height: number },
  align: "left" | "right",
  placement: "below" | "above",
) {
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const fitsBelow = trigger.bottom + GAP + panel.height <= viewportH;
  const fitsAbove = trigger.top - GAP - panel.height >= 0;
  const above = placement === "above" ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
  const fitsRight = trigger.left + panel.width <= viewportW;
  const fitsLeft = trigger.right - panel.width >= 0;
  const alignRight = align === "right" ? fitsLeft || !fitsRight : !fitsRight && fitsLeft;
  return {
    top: above ? "" : `${trigger.bottom + GAP}px`,
    bottom: above ? `${viewportH - trigger.top + GAP}px` : "",
    left: alignRight ? "" : `${trigger.left}px`,
    right: alignRight ? `${viewportW - trigger.right}px` : "",
  };
}

// One popover for the three the book page needs — the book menu, the variant picker and the tray's
// overflow. Escape comes from Modal.tsx's stack, so a menu opened over a dialog closes itself first.
// Pointer dismissal is written here rather than borrowed from useDismissOnOutsidePointer, because
// that hook closes on pointerdown and lets the click through — and a Modal's scrim is a sibling div
// with onClick={onClose}, so dismissing a menu inside a dialog would take the dialog with it.
export function Menu({
  trigger,
  children,
  align = "right",
  placement = "below",
  width = "w-56",
  testId,
}: {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  placement?: "below" | "above";
  width?: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Portalled to the body and positioned `fixed`: an `absolute` panel inside a table's overflow-x
  // wrapper (which clips vertically too) was cut off on the last rows. The position is written to
  // the panel's style from a layout effect, so it never paints at the wrong spot.
  const panel = useRef<HTMLDivElement>(null);
  // Into the dialog's own subtree when opened from one: aria-modal hides everything outside it from
  // assistive tech, and a fixed panel is not clipped by the dialog's overflow-hidden anyway.
  const [host, setHost] = useState<HTMLElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  useTopmostEscape(close, open);

  const fill = width === "w-full";
  const reposition = useCallback(() => {
    const trigger = root.current?.getBoundingClientRect();
    const el = panel.current;
    if (!trigger || !el) return;
    if (fill) el.style.width = `${trigger.width}px`;
    Object.assign(el.style, placePanel(trigger, { width: el.offsetWidth, height: el.offsetHeight }, align, placement));
    el.style.visibility = "";
  }, [align, placement, fill]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // The trigger moves when any ancestor scrolls or the window resizes, and the panel changes size
    // when a searchable list is filtered; either can change which side fits.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const observer = new ResizeObserver(reposition);
    if (panel.current) observer.observe(panel.current);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      observer.disconnect();
    };
  }, [open, reposition]);

  // Held in a ref, not in the effect below: closing the menu re-runs that effect, and a swallow
  // registered inside it would be torn down by its own cleanup before the click it exists to eat.
  const swallowRef = useRef<{ click: (e: MouseEvent) => void; cancel: () => void } | null>(null);
  const clearSwallow = useCallback(() => {
    const armed = swallowRef.current;
    if (!armed) return;
    document.removeEventListener("click", armed.click, { capture: true });
    document.removeEventListener("pointercancel", armed.cancel, { capture: true });
    window.removeEventListener("blur", armed.cancel);
    swallowRef.current = null;
  }, []);
  useEffect(() => clearSwallow, [clearSwallow]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
      // The click this pointerdown becomes is still on its way to whatever is underneath — a Modal's
      // scrim, or the next button along. One dismissal is one dismissal.
      clearSwallow();
      // Only a primary press becomes a click: a middle or right button never does, and a touch that
      // turns into a scroll cancels instead. An armed swallow left over from one eats somebody else's.
      if (e.button !== 0) return;
      const click = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        clearSwallow();
      };
      const cancel = () => clearSwallow();
      swallowRef.current = { click, cancel };
      document.addEventListener("click", click, { capture: true, once: true });
      document.addEventListener("pointercancel", cancel, { capture: true, once: true });
      // Holding the button, switching away and releasing outside produces neither a click nor a
      // pointercancel, and the swallow would sit armed until it ate somebody else's click.
      window.addEventListener("blur", cancel, { once: true });
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, clearSwallow]);

  return (
    <div
      ref={root}
      className="relative"
      onClickCapture={(e) => setHost(e.currentTarget.closest<HTMLElement>('[role="dialog"]') ?? document.body)}
    >
      {trigger({ open, toggle })}
      {open &&
        createPortal(
          // z above Modal's z-[60]: a menu opened inside a dialog must still paint over it.
          <div
            ref={panel}
            className={`fixed z-[70] ${fill ? "" : width} p-1.5 rounded-xl border border-(--border) bg-(--bg-card) shadow-2xl`}
            style={{ visibility: "hidden" }}
            data-testid={testId}
          >
            {children(close)}
          </div>,
          host ?? document.body,
        )}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  icon,
  title,
  disabled,
  danger,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  return (
    // button-ok: a menu item's skin belongs to the menu — Button's variants would fight the row
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[13px] disabled:opacity-50 disabled:cursor-not-allowed ${
        danger
          ? "text-(--danger-text) enabled:hover:bg-(--danger-bg)"
          : "text-(--text-primary) enabled:hover:bg-(--bg-card-hover)"
      }`}
    >
      {icon}
      <span className="flex-1 min-w-0">{children}</span>
    </button>
  );
}

export function MenuDivider() {
  return <div className="h-px my-1.5 mx-1 bg-(--border)" />;
}
