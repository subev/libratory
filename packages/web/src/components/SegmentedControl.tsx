import type { ReactNode } from "react";

// Promoted out of Reader.tsx, where this shape already existed. The skin is a prop because the
// unselected half was byte-identical across every hand-written copy and the selected half never was:
// "raised" is a trough with a card-coloured thumb, "accent" fills, for a control that has to carry a
// dense toolbar on its own.
type SegmentedOption = {
  id: string;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
};

const CONTAINER = {
  raised: "bg-(--bg-subtle) border-(--border) rounded-lg",
  accent: "bg-(--bg-card) border-(--border) rounded",
};

const SELECTED = {
  raised: "bg-(--bg-card) shadow-sm text-(--text-primary)",
  accent: "bg-(--accent) text-(--on-accent)",
};

const IDLE = {
  raised: "text-(--text-muted) hover:text-(--text-secondary)",
  accent: "text-(--text-tertiary) hover:bg-(--bg-subtle)",
};

const PAD = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-1 text-xs font-medium",
};

export function SegmentedControl({
  options,
  value,
  onChange,
  testId,
  variant = "raised",
  size = "md",
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  testId: string;
  variant?: keyof typeof SELECTED;
  size?: keyof typeof PAD;
}) {
  return (
    <div className={`inline-flex border p-0.5 gap-0.5 min-w-0 ${CONTAINER[variant]}`} data-testid={testId}>
      {options.map((option) => {
        const selected = value === option.id;
        return (
          // button-ok: a segmented selection — data-active marks the chosen option, it is not an action
          <button
            key={option.id}
            type="button"
            onClick={() => !option.disabled && onChange(option.id)}
            disabled={option.disabled}
            title={option.title}
            data-testid={`${testId}-${option.id}`}
            data-active={selected}
            className={`rounded truncate min-w-0 max-w-64 ${PAD[size]} ${
              selected ? SELECTED[variant] : option.disabled ? "text-(--text-faint) cursor-not-allowed" : IDLE[variant]
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
