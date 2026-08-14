/**
 * Diversity pass — applied unconditionally, not gated on whether an explicit
 * model list was parsed. This directly fixes the known bare-category gap in
 * the flagship app (diversity logic there only fires when a model list is
 * supplied — SYS-20260812-002).
 */
import type { AutoDevListing } from "./auto-dev-client";

const MAX_PER_MAKE_MODEL = 2;

/**
 * Safe string coercion for values that SHOULD be strings but aren't always
 * (real bug found 2026-08-14: `(x ?? "").toLowerCase()` crashed the entire
 * search whenever Auto.dev returned a non-string, non-null value for
 * make/model on even one of 100 candidates - `??` only catches null/undefined,
 * not other unexpected types. String() safely handles any input type.
 */
function safeLower(x: unknown): string {
  return String(x ?? "").toLowerCase();
}

export function applyDiversity(listings: AutoDevListing[], limit: number): AutoDevListing[] {
  const seen = new Map<string, number>();
  const result: AutoDevListing[] = [];

  for (const listing of listings) {
    const key = `${safeLower(listing.vehicle?.make)}|${safeLower(listing.vehicle?.model)}`;
    const count = seen.get(key) ?? 0;
    if (count >= MAX_PER_MAKE_MODEL) continue;
    seen.set(key, count + 1);
    result.push(listing);
    if (result.length >= limit) break;
  }

  // Backfill if diversity capping left us short of the limit
  if (result.length < limit) {
    for (const listing of listings) {
      if (result.includes(listing)) continue;
      result.push(listing);
      if (result.length >= limit) break;
    }
  }

  return result;
}
