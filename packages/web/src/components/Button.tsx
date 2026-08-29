import type { ComponentPropsWithRef, ReactNode } from "react";
import { Link } from "react-router";

type Variant = "primary" | "secondary" | "danger" | "warning" | "success" | "ghost" | "icon";
type Size = "sm" | "md";

const BASE = "inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed";

const VARIANT: Record<Variant, string> = {
  primary: "bg-(--accent) text-(--on-accent) hover:bg-(--accent-hover)",
  secondary: "border border-(--border-input) bg-(--bg-card) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-card-hover)",
  danger: "bg-(--danger) text-(--on-danger) hover:bg-(--danger-hover)",
  warning: "bg-(--warning) text-(--on-warning) hover:bg-(--warning-hover)",
  success: "bg-(--success) text-(--on-success) hover:bg-(--success-hover)",
  ghost: "text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-subtle)",
  icon: "border border-(--border) text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-subtle) shrink-0",
};

const SIZE: Record<Variant, Record<Size, string>> = {
  primary: { sm: "text-xs px-2.5 py-1 rounded", md: "text-sm px-4 py-2 rounded-md" },
  secondary: { sm: "text-xs px-2.5 py-1 rounded", md: "text-sm px-4 py-2 rounded-md" },
  danger: { sm: "text-xs px-2.5 py-1 rounded", md: "text-sm px-4 py-2 rounded-md" },
  warning: { sm: "text-xs px-2.5 py-1 rounded", md: "text-sm px-4 py-2 rounded-md" },
  success: { sm: "text-xs px-2.5 py-1 rounded", md: "text-sm px-4 py-2 rounded-md" },
  ghost: { sm: "text-xs px-2 py-1 rounded", md: "text-sm px-3 py-1.5 rounded-md" },
  icon: { sm: "w-7 h-7 rounded-md", md: "w-9 h-9 rounded-md" },
};

// The quiet register of a variant: colour without the weight of a fill, for a control that must warn
// rather than shout. The type only admits `soft` on the variants listed here.
type SoftVariant = "primary" | "danger" | "warning" | "success";

const SOFT: Record<SoftVariant, string> = {
  primary: "text-(--accent-text) hover:text-(--accent-text-hover) hover:bg-(--bg-subtle)",
  danger: "bg-(--danger-bg) text-(--danger-text) hover:bg-(--danger-bg-hover)",
  warning: "bg-(--warning-bg) text-(--warning-text) hover:bg-(--warning-bg-hover)",
  success: "bg-(--success-bg) text-(--success-text) hover:bg-(--success-bg-hover)",
};

type Common = {
  variant?: Variant;
  size?: Size;
  className?: string;
  children?: ReactNode;
};

// An icon-only button has no text to name it, so the label is not optional.
type Labelled = { variant: "icon"; "aria-label": string } | { variant?: Exclude<Variant, "icon"> };

type Softness = { soft: true; variant: SoftVariant } | { soft?: false };

type AsButton = Common & ComponentPropsWithRef<"button"> & { href?: never; to?: never };
type AsLink = Common & Omit<ComponentPropsWithRef<"a">, "href"> & { href: string; to?: never; disabled?: boolean };
type AsRoute = Common & Omit<ComponentPropsWithRef<"a">, "href"> & { to: string; href?: never; disabled?: boolean };

export type ButtonProps = (AsButton | AsLink | AsRoute) & Labelled & Softness;

export function Button(props: ButtonProps) {
  const { variant = "secondary", soft = false, size = "md", className = "", children, ...rest } = props;
  const skin = soft ? SOFT[variant as SoftVariant] : VARIANT[variant];
  const classes = `${BASE} ${skin} ${SIZE[variant][size]} ${className}`.trim();
  const { href, to, disabled, download, target, rel, ...attrs } = rest as {
    href?: string;
    to?: string;
    disabled?: boolean;
    download?: string | boolean;
    target?: string;
    rel?: string;
  };
  const anchorOnly = { download, target, rel };

  // A disabled anchor still navigates, so an unavailable link becomes a real disabled button rather
  // than disappearing — the app shows actions it cannot do, it does not hide them.
  if (to !== undefined && !disabled) {
    return (
      <Link {...(attrs as ComponentPropsWithRef<"a">)} {...anchorOnly} to={to} className={`${classes} no-underline`}>
        {children}
      </Link>
    );
  }

  if (href !== undefined && !disabled) {
    return (
      <a {...(attrs as ComponentPropsWithRef<"a">)} {...anchorOnly} href={href} className={`${classes} no-underline`}>
        {children}
      </a>
    );
  }

  return (
    <button type="button" {...(attrs as ComponentPropsWithRef<"button">)} disabled={disabled} className={classes}>
      {children}
    </button>
  );
}
