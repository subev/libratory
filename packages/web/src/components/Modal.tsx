import { useEffect, type ReactNode } from "react";
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

  useEffect(() => {
    if (!closeOnEscape) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [closeOnEscape, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid={backdropTestId}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
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
