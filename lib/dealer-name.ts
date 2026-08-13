 * Dealer name sanitization helper.
 *
 * Auto.dev feed identifiers like "ClementFord New VinSolutions Only" leak
 * DMS/feed-connector suffixes into the UI. This helper strips known suffixes
 * and normalizes whitespace, returning a display-safe dealer name.
 *
 * The raw value is preserved at call sites as `dealer_name_raw` for debugging.
 */

// Known feed-connector suffixes to strip, checked in order (longest/most-specific first).
const STRIP_SUFFIXES = [
  "vinsolutions only",
  "vinsolutions",
  "inventory feed",
  "dms feed",
  "auto feed",
  "feed only",
  "dms",
];

/**
 * Returns a sanitized, display-safe dealer name.
 *
 * Rules:
 *   - null/undefined input ? "Dealer"
 *   - Strips one matching case-insensitive trailing suffix
 *   - Trims leading/trailing whitespace; collapses internal multi-spaces
 *   - Result shorter than 3 characters ? "Authorized Dealer"
 */
export function sanitizeDealerName(rawName: string | null | undefined): string {
  if (rawName == null) return "Dealer";

  let name = rawName.trim();
  if (name === "") return "Dealer";

  // Strip one known feed-connector suffix (case-insensitive) from the end
  const lower = name.toLowerCase();
  for (const suffix of STRIP_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      name = name.slice(0, name.length - suffix.length);
      break;
    }
  }

  // Normalize whitespace
  name = name.trim().replace(/\s{2,}/g, " ");

  if (name.length < 3) return "Authorized Dealer";

  return name;
}
