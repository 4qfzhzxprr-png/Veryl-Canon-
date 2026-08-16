/**
 * The suite mark. Colours are FIXED — #2D6BFF tile, white spine and check —
 * and it is never recoloured or theme-tinted (BRAND.md "Misuse"). It is the
 * single most ownable expression of the brand, and the reason somebody
 * arriving from the Registry recognises the same company before reading a word.
 *
 * Identical to the Registry's component, deliberately: this is the first thing
 * that should live in a shared package when one exists.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden className="shrink-0">
      <rect width="64" height="64" rx="15" fill="#2D6BFF" />
      <rect x="16" y="15" width="7" height="34" rx="3.5" fill="#FFFFFF" />
      <path d="M30 34 L37.5 42 L50 21" fill="none" stroke="#FFFFFF" strokeWidth="7"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
