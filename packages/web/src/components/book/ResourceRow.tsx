import type { ReactNode } from "react";

// The same row four times over in the artboard — source files, assemblies, documents, notes. Tile,
// title, subtitle, a status word, then the actions.
export function ResourceRow({
  icon,
  tone = "muted",
  title,
  subtitle,
  badge,
  actions,
  children,
  testId,
}: {
  icon: ReactNode;
  tone?: "accent" | "muted";
  title: ReactNode;
  subtitle: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  /** An inline player, or anything else that belongs under the title rather than beside it. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <li
      className="flex items-center gap-3 px-3 py-2.5 border border-(--border) rounded-lg bg-(--bg-card) hover:bg-(--bg-card-hover)"
      data-testid={testId}
    >
      <span
        className={`w-7 h-7 shrink-0 grid place-items-center rounded-md ${
          tone === "accent" ? "bg-(--accent-subtle) text-(--accent-text)" : "bg-(--bg-subtle) text-(--text-muted)"
        }`}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-(--text-primary) truncate">{title}</span>
        <span className="block mt-0.5 text-xs text-(--text-muted) truncate">{subtitle}</span>
        {children}
      </span>
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
