import type { ComponentPropsWithRef, ReactNode } from "react";

// The stripe is the one place colour still encodes a sequence: 1 Input, 2 Work, 3 Output. Tailwind
// cannot build a class from a variable, so the ramp is a fixed map rather than a token argument.
// The opacities stay here rather than in styles.css because --alpha() only folds for a literal —
// given a var() it emits a dead @supports block with an opaque fallback. Red reads heavier than
// brass or green at the same alpha, so danger is 70 where the sequence is 80; that is deliberate.
type Stripe = "input" | "work" | "output" | "danger" | "none";

const STRIPE: Record<Stripe, string> = {
  input: "border-t-(--step-input)/80",
  work: "border-t-(--step-work)/80",
  output: "border-t-(--step-output)/80",
  danger: "border-t-(--danger)/70",
  none: "border-t-(--border)",
};

type SectionProps = ComponentPropsWithRef<"section"> & {
  stripe?: Stripe;
  className?: string;
  children?: ReactNode;
};

export function Section({ stripe = "none", className = "", children, ...rest }: SectionProps) {
  return (
    <section
      {...rest}
      className={`rounded-xl border border-(--border) border-t-2 ${STRIPE[stripe]} bg-(--bg-card) p-4 ${className}`}
    >
      {children}
    </section>
  );
}
