/**
 * Directional model matcher (SYS-20260824) — fixes the previously symmetric
 * matchesAnyInList() prefix check (`v === opt || v.startsWith(opt) ||
 * opt.startsWith(v)`), which let a less-specific ACTUAL model satisfy a
 * more-specific REQUESTED model — e.g. a requested "RAV4 Hybrid" was
 * wrongly satisfied by an actual reported model of plain "RAV4", which
 * doesn't confirm the hybrid variant at all.
 *
 * Model-specific only — make matching is deliberately left as the existing
 * symmetric matchesAnyInList() in lib/post-verify.ts and lib/match-score.ts
 * (out of scope here; make names don't have the same
 * more-specific-variant relationship model names do).
 *
 * Directional, normalized, token-subset: every token of the REQUESTED
 * model must appear among the ACTUAL model's tokens.
 * - Exact normalized match -> true.
 * - A more-specific actual (e.g. "Silverado 1500 Crew Cab" for a requested
 *   "Silverado 1500") still satisfies the request -> true.
 * - A less-specific actual (e.g. "RAV4" for a requested "RAV4 Hybrid")
 *   never satisfies a more-specific request -> false.
 * - Case/punctuation differences don't matter.
 * - `requested` may be a comma-separated OR list (Auto.dev's native list
 *   syntax, e.g. "RAV4 Hybrid,CR-V Hybrid") — satisfied if ANY option in
 *   the list is satisfied.
 */

function normalize(s: string): string {
  return s
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

function oneOptionSatisfies(requestedOption: string, actual: string): boolean {
  const reqTokens = tokens(requestedOption);
  if (reqTokens.length === 0) return false;
  const actTokens = new Set(tokens(actual));
  return reqTokens.every((t) => actTokens.has(t));
}

/**
 * `requested` is a single model name OR a comma-separated OR list.
 * `actual` is the listing's own reported model value — typed `unknown`
 * and String()-coerced defensively (real bug found 2026-08-14: Auto.dev
 * can return a non-string value for make/model on rare/varied vehicles
 * despite the declared type, and a bare `.trim()`/`.toLowerCase()` throws
 * on it — same class of bug already fixed in diversity.ts).
 */
export function modelSatisfiesRequested(requested: string, actual: unknown): boolean {
  if (actual == null || actual === "") return false;
  const actualStr = String(actual);
  const options = requested
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return options.some((opt) => oneOptionSatisfies(opt, actualStr));
}
