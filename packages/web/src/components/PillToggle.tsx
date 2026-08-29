import type { ReactNode } from "react";

export function PillToggle({
  selected,
  onClick,
  title,
  disabled,
  testId,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  // button-ok: a toggle is not an action; aria-pressed and the pill shape are its own
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
      }`}
    >
      {children}
    </button>
  );
}
