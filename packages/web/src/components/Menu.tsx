import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTopmostEscape } from "./Modal.tsx";

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

  const close = useCallback(() => setOpen(false), []);
  useTopmostEscape(close, open);

  useEffect(() => {
    if (!open) return;
    let swallow: ((e: MouseEvent) => void) | null = null;
    function onPointerDown(e: PointerEvent) {
      if (root.current?.contains(e.target as Node)) return;
      setOpen(false);
      // The click this pointerdown becomes is still on its way to whatever is underneath. One
      // dismissal is one dismissal, so it does not also press the button it landed on.
      swallow = (click) => {
        click.stopPropagation();
        click.preventDefault();
      };
      document.addEventListener("click", swallow, { capture: true, once: true });
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      if (swallow) document.removeEventListener("click", swallow, { capture: true });
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          className={`absolute z-50 ${width} p-1.5 rounded-xl border border-(--border) bg-(--bg-card) shadow-2xl ${
            align === "right" ? "right-0" : "left-0"
          } ${placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
          data-testid={testId}
        >
          {children(close)}
        </div>
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
