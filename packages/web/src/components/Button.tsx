import type { ComponentPropsWithRef } from "react";
import { Link } from "react-router";

export const VARIANTS = ["primary", "secondary", "danger", "warning", "success", "ghost", "icon"] as const;

type Variant = (typeof VARIANTS)[number];
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

// Only two variants deviate on size; the filled ones were five identical rows.
const PAD: Record<Size, string> = { sm: "text-xs px-2.5 py-1 rounded", md: "text-sm px-4 py-2 rounded-md" };
// The icon box, available to every skin, so a coloured icon lines up in a row of plain ones.
const BOX: Record<Size, string> = { sm: "w-7 h-7 rounded-md", md: "w-9 h-9 rounded-md" };
const SIZE: Partial<Record<Variant, Record<Size, string>>> = {
  ghost: { sm: "text-xs px-2 py-1 rounded", md: "text-sm px-3 py-1.5 rounded-md" },
  icon: BOX,
};

// The quiet register of a variant: colour without the weight of a fill, for a control that must warn
// rather than shout. The type only admits `soft` on the variants listed here.
const SOFT = {
  primary: "text-(--accent-text) hover:text-(--accent-text-hover) hover:bg-(--bg-subtle)",
  danger: "bg-(--danger-bg) text-(--danger-text) hover:bg-(--danger-bg-hover)",
  warning: "bg-(--warning-bg) text-(--warning-text) hover:bg-(--warning-bg-hover)",
  success: "bg-(--success-bg) text-(--success-text) hover:bg-(--success-bg-hover)",
} satisfies Partial<Record<Variant, string>>;

type SoftVariant = keyof typeof SOFT;

export const SOFT_VARIANTS = Object.keys(SOFT) as SoftVariant[];

type Common = { variant?: Variant; size?: Size; square?: boolean };

// An icon-only button has no text to name it, so the label is not optional.
type Labelled =
  | { variant: "icon"; "aria-label": string }
  | { square: true; "aria-label": string }
  | { variant?: Exclude<Variant, "icon">; square?: false };

type Softness = { soft: true; variant: SoftVariant } | { soft?: false };

type AsButton = Common & ComponentPropsWithRef<"button"> & { href?: never; to?: never };
type AsLink = Common & Omit<ComponentPropsWithRef<"a">, "href"> & { href: string; to?: never; disabled?: boolean };
type AsRoute = Common & Omit<ComponentPropsWithRef<"a">, "href"> & { to: string; href?: never; disabled?: boolean };

type ButtonProps = (AsButton | AsLink | AsRoute) & Labelled & Softness;

export function Button(props: ButtonProps) {
  const { variant = "secondary", soft = false, square = false, size = "md", className = "", children, ...rest } = props;
  const skin = soft ? SOFT[variant as SoftVariant] : VARIANT[variant];
  const geometry = square ? BOX[size] : (SIZE[variant] ?? PAD)[size];
  const classes = `${BASE} ${skin} ${geometry} ${className}`.trim();
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
  if (!disabled && (to !== undefined || href !== undefined)) {
    const shared = {
      ...(attrs as ComponentPropsWithRef<"a">),
      ...anchorOnly,
      className: `${classes} no-underline`,
    };
    return to !== undefined ? (
      <Link {...shared} to={to}>
        {children}
      </Link>
    ) : (
      <a {...shared} href={href}>
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
