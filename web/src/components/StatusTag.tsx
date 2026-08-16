import { STATUS_LABELS } from "@/lib/format";

/**
 * A page's standing, rendered the same way everywhere.
 *
 * **Never colour alone.** Each tag carries its word, because the difference
 * between Canonical and Draft is the difference between "you may act on this"
 * and "you may not", and a reader who cannot distinguish green from grey — one
 * man in twelve — would be reading the same tag either way. The colour is the
 * fast path for everyone else, not the message.
 */
const TONE: Record<string, string> = {
  canonical: "bg-ok/12 text-ok border-ok/30",
  needs_update: "bg-warn/12 text-warn border-warn/30",
  in_review: "bg-action/10 text-action border-action/30",
  draft: "bg-surface-2 text-muted border-border",
  archived: "bg-surface-2 text-muted border-border",
  superseded: "bg-surface-2 text-muted border-border",
};

export function StatusTag({ status, className = "" }: { status: string; className?: string }) {
  const tone = TONE[status] ?? TONE["draft"]!;
  return (
    <span
      className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-meta font-medium ${tone} ${className}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
