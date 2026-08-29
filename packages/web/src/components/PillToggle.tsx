import type { ReactNode } from "react";

// One "selected" affordance. Nine of these were written by hand in two mutually inconsistent
// designs, and only one carried aria-pressed.
export function PillToggle({
  selected,
  onClick,
  title,
  disabled,
  className = "",
  testId,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      title={title}
      disabled={disabled}
      data-testid={testId}
      className={`text-xs px-2.5 py-1 rounded-full border font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
        selected
          ? "bg-(--accent) border-(--accent) text-(--on-accent)"
          : "border-(--border) text-(--text-secondary) hover:bg-(--accent-subtle)"
      } ${className}`}
    >
      {children}
    </button>
  );
}
