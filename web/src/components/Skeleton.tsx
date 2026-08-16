// Loading, shaped like the thing that is coming.
//
// A spinner says "wait"; a skeleton says "wait, and here is roughly what for",
// which stops the layout jumping when content lands. Variants exist so callers
// choose a SHAPE rather than passing pixel dimensions — a caller that can pass
// arbitrary sizes will, and the shapes stop matching what settles.
type Variant = "line" | "block" | "card" | "row";

const SHAPE: Record<Variant, string> = {
  line: "h-4 w-full",
  block: "h-32 w-full",
  card: "h-24 w-full rounded-lg",
  row: "h-6 w-48",
};

export function Skeleton({
  variant = "line",
  className = "",
  label,
}: {
  variant?: Variant;
  className?: string;
  /** What is loading, for screen readers. Without it the wait is silent: a
   *  sighted user sees shimmering blocks and a screen-reader user sees nothing
   *  at all until the content arrives. */
  label: string;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <div className={`animate-pulse rounded-md bg-surface-2 ${SHAPE[variant]}`} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
