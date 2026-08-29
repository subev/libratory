import { useEffect, useRef, type ReactNode } from "react";
import { useBodyScrollLock } from "../lib/use-body-scroll-lock.ts";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

const PANEL_SIZE: Record<ModalSize, string> = {
  sm: "w-[90vw] max-w-md max-h-[85vh]",
  md: "w-[90vw] max-w-2xl max-h-[85vh]",
  lg: "w-[90vw] max-w-5xl h-[80vh]",
  xl: "w-[92vw] max-w-6xl h-[85vh]",
  full: "w-[96vw] h-[92vh]",
};

export function Modal({
  size = "md",
  onClose,
  closeOnEscape = false,
  labelledBy,
  testId,
  backdropTestId,
  children,
}: {
  size?: ModalSize;
  onClose: () => void;
  closeOnEscape?: boolean;
  labelledBy?: string;
  testId?: string;
  backdropTestId?: string;
  children: ReactNode;
}) {
  useBodyScrollLock();

  const panel = useRef<HTMLDivElement>(null);

  // aria-modal hides the rest of the page from assistive tech, so focus has to come in with it —
  // and go back to whatever opened the dialog on the way out.
  useEffect(() => {
    const opener = document.activeElement;
    const node = panel.current;
    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      (first ?? node).focus();
    }
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    function trap(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const node = panel.current;
      if (!node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, []);

  useEffect(() => {
    if (!closeOnEscape) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [closeOnEscape, onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" data-testid={backdropTestId}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative bg-(--bg-card) rounded-xl shadow-2xl flex flex-col overflow-hidden ${PANEL_SIZE[size]}`}
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}
