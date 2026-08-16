import type { ReactNode } from "react";

/**
 * Nothing here, and why — which is the part usually missed.
 *
 * "No pages" is a fact; "No pages yet — the first one you write becomes the
 * canonical answer" is an invitation. An empty state that only reports absence
 * makes a new user think the product is broken, and a new WORKSPACE is the
 * moment every user is a new user.
 *
 * `action` is optional because not every emptiness is actionable by this
 * reader: a collection they can read but not write to is empty and stays that
 * way, and offering them a button that 403s is worse than offering none.
 */
export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-md py-2xl text-center">
      {icon ? <div className="mb-1 text-muted">{icon}</div> : null}
      <h2 className="font-semibold text-text">{title}</h2>
      <p className="max-w-sm text-ui text-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
