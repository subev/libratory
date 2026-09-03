import type { ReactNode } from "react";

// A tile that acts has to be named, the way Button.tsx makes aria-label mandatory on its icon
// variants; a tile that only labels the row takes a tone instead.
type Tile =
  // `active` lives here because only an acting tile has a lit state: it fills the tile and gives the
  // row an accent edge, so one row reads as live down a list
  | { onIconClick: () => void; iconLabel: string; active?: boolean; tone?: never }
  | { onIconClick?: never; iconLabel?: never; active?: never; tone?: "accent" | "muted" };

// Tile, title, subtitle, a status word, then the actions — the shape the artboard draws for every
// produced file. Assemblies and documents share it; source files stay a <table> (they carry a
// selection with shift-range) and notes are expandable prose, so neither is forced through it.
export function ResourceRow({
  icon,
  tone = "muted",
  active = false,
  onIconClick,
  iconLabel,
  title,
  subtitle,
  trailing,
  badge,
  actions,
  testId,
}: Tile & {
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  /** A transport, or anything else that belongs on the row's own line rather than under the title. */
  trailing?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <li
      className={`flex items-center gap-3 px-3 py-2.5 border rounded-lg bg-(--bg-card) hover:bg-(--bg-card-hover) ${
        active ? "border-(--accent)" : "border-(--border)"
      }`}
      data-testid={testId}
    >
      {onIconClick ? (
        // button-ok: the tile is a 28px circle that fills with the accent while it plays; no Button
        // variant is round, and none changes fill on state.
        <button
          type="button"
          onClick={onIconClick}
          aria-label={iconLabel}
          title={iconLabel}
          className={`w-7 h-7 shrink-0 grid place-items-center rounded-full border cursor-pointer ${
            active ? "bg-(--accent) text-(--on-accent) border-(--accent)" : "bg-(--bg-card) text-(--accent-text) border-(--border-input) hover:bg-(--bg-subtle)"
          }`}
        >
          {icon}
        </button>
      ) : (
        <span
          className={`w-7 h-7 shrink-0 grid place-items-center rounded-md ${
            tone === "accent" ? "bg-(--accent-subtle) text-(--accent-text)" : "bg-(--bg-subtle) text-(--text-muted)"
          }`}
        >
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-(--text-primary) truncate">{title}</span>
        <span className="block mt-0.5 text-xs text-(--text-muted) truncate">{subtitle}</span>
      </span>
      {trailing}
      {badge}
      {actions && <span className="flex items-center gap-1 shrink-0">{actions}</span>}
    </li>
  );
}

export function ResourceGroup({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="font-(family-name:--stack-display) text-base font-semibold text-(--text-primary)">{title}</h2>
        <span className="text-xs text-(--text-muted)">{count}</span>
        <div className="flex-1" />
        {action}
      </div>
      <ul className="flex flex-col gap-1.5">{children}</ul>
    </section>
  );
}
