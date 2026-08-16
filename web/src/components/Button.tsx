import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT: Record<Variant, string> = {
  primary: "bg-action text-action-text hover:opacity-90",
  secondary: "border border-border bg-surface text-text hover:bg-surface-2",
  ghost: "text-action hover:bg-surface-2",
  danger: "border border-danger/40 bg-surface text-danger hover:bg-danger/10",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Replaces the label while a write is in flight AND disables the control.
   *  One prop for both, because the two coming apart is how a button ends up
   *  looking busy while still accepting a second click. */
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  busy = false,
  busyLabel,
  children,
  className = "",
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      // Explicit, because a <button> inside a <form> defaults to submit and a
      // "Cancel" that submits the form is a genuinely expensive default.
      type={type}
      // 44px is the touch target this has to clear on a phone, not a rounding
      // of 40. The text stays at the UI size so it does not trip the iOS zoom
      // guard on the form controls beside it.
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md px-3 text-ui font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANT[variant]} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

/**
 * A control the server has already said this actor may not use.
 *
 * It stays VISIBLE and disabled rather than disappearing, and it carries the
 * server's own sentence as its title and its accessible description. A control
 * that vanishes teaches nobody why; one that is present and explained tells the
 * reader what they would need in order to use it — which is usually a role
 * somebody else can grant them.
 */
export function RefusedButton({
  children,
  why,
  variant = "primary",
}: {
  children: ReactNode;
  why: string | null;
  variant?: Variant;
}) {
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button variant={variant} disabled aria-describedby={why ? undefined : undefined} title={why ?? undefined}>
        {children}
      </Button>
      {why ? <span className="text-meta text-muted">{why}</span> : null}
    </span>
  );
}
