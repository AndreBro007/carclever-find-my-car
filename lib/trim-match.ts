/**
 * Trim/variant matcher for `trimRequired` (SYS-20260823 — explicit trim
 * requests were being treated as soft ranking preferences, e.g. "Mercedes
 * AMG GLA 35" returning GLA 250s as "Strong match"). Deliberately NOT used
 * to build an Auto.dev query filter — `vehicle.trim` is not trusted as a
 * hard Auto.dev filter param anywhere in this codebase, and this module
 * doesn't change that; it's a local, post-fetch matcher only.
 *
 * Normalized, directional, token-subset matching:
 * - Case, punctuation, and trademark symbols (®, ™, ©) are stripped before
 *   comparing, so "AMG® GLA 35" and "amg gla-35" compare equal.
 * - A letter/digit boundary gets a space inserted ("GLA35" -> "GLA 35") so
 *   minor formatting differences between what a host model sends and what
 *   Auto.dev reports don't cause a false non-match.
 * - Directional: every token in the REQUESTED trim must appear in the
 *   ACTUAL (reported) trim's tokens. This means a less-specific actual
 *   trim ("AMG" alone) never satisfies a more-specific request ("AMG GLA
 *   35") — it's missing the "gla" and "35" tokens — while a more-specific
 *   actual trim can still satisfy a less-specific request.
 */

function normalize(s: string): string {
  return s
    .replace(/[®™©]/g, "")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  const normalized = normalize(s);
  return normalized.length > 0 ? normalized.split(/\s+/) : [];
}

/**
 * True when every token of `requested` is present among the tokens of
 * `actual`. Returns false for an empty/missing `actual` (an unknown trim
 * can never be a CONFIRMED match — callers decide separately whether an
 * unknown trim should be treated as provisional-pass or hard-fail
 * depending on which stage they're at).
 */
export function trimMatches(requested: string, actual: string | null | undefined): boolean {
  const reqTokens = tokens(requested);
  if (reqTokens.length === 0) return false;
  if (!actual) return false;
  const actTokens = new Set(tokens(actual));
  return reqTokens.every((t) => actTokens.has(t));
}
