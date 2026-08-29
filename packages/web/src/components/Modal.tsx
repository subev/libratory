import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { useBodyScrollLock } from "../lib/use-body-scroll-lock.ts";
import { IconClose } from "./icons.tsx";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

const FOCUSABLE =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

const PANEL_SIZE: Record<ModalSize, string> = {
  sm: "w-[90vw] max-w-md max-h-[85vh]",
  md: "w-[90vw] max-w-2xl max-h-[85vh]",
  lg: "w-[90vw] max-w-5xl h-[80vh]",
  xl: "w-[92vw] max-w-6xl h-[85vh]",
  full: "w-[96vw] h-[92vh]",
};

const TitleIdContext = createContext<string | undefined>(undefined);

export function ModalHeader({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  const titleId = useContext(TitleIdContext);
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-(--border) shrink-0">
      <div className="min-w-0">
        <h2 id={titleId} className="text-base font-semibold text-(--text-primary) truncate">{title}</h2>
        {subtitle ? <p className="text-xs text-(--text-muted) mt-0.5">{subtitle}</p> : null}
      </div>
      {children}
      <button
        type="button"
        onClick={onClose}
        title="Close"
        aria-label="Close"
        className="ml-auto shrink-0 p-1 rounded text-(--text-faint) hover:text-(--text-tertiary)"
      >
        <IconClose className="h-5 w-5" />
      </button>
    </div>
  );
}

// Every dialog used to put its own Escape listener on document, so opening one from inside another
// closed both. A stack means the innermost registrant wins; ChapterModal used to approximate this
// with a hand-kept list of "things currently on top of me", which is why Ask AI was missing from it.
const escapeStack: Array<() => void> = [];

function onDocumentEscape(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  escapeStack.at(-1)?.();
}

export function useTopmostEscape(onEscape: () => void, enabled = true) {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!enabled) return;
    const entry = () => latest.current();
    if (escapeStack.length === 0) document.addEventListener("keydown", onDocumentEscape);
    escapeStack.push(entry);
    return () => {
      escapeStack.splice(escapeStack.indexOf(entry), 1);
      if (escapeStack.length === 0) document.removeEventListener("keydown", onDocumentEscape);
    };
  }, [enabled]);
}

export function Modal({
  size = "md",
  onClose,
  closeOnEscape = true,
  testId,
  backdropTestId,
  children,
}: {
  size?: ModalSize;
  onClose: () => void;
  /** Escape closes by default; opt out only where a dialog owns the key itself. */
  closeOnEscape?: boolean;
  testId?: string;
  backdropTestId?: string;
  children: ReactNode;
}) {
  useBodyScrollLock();

  const titleId = useId();

  const panel = useRef<HTMLDivElement>(null);

  // aria-modal hides the page from assistive tech, so focus must enter and return to the opener.
  useEffect(() => {
    const opener = document.activeElement;
    const node = panel.current;
    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const node = panel.current;
      if (!node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useTopmostEscape(onClose, closeOnEscape);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" data-testid={backdropTestId}>
      <div className="absolute inset-0 bg-(--scrim)" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative bg-(--bg-card) rounded-xl shadow-2xl flex flex-col overflow-hidden ${PANEL_SIZE[size]}`}
        data-testid={testId}
      >
        <TitleIdContext.Provider value={titleId}>{children}</TitleIdContext.Provider>
      </div>
    </div>
  );
}
