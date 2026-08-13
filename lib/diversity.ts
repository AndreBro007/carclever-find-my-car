/**
 * Diversity pass — applied unconditionally, not gated on whether an explicit
 * model list was parsed. This directly fixes the known bare-category gap in
 * the flagship app (diversity logic there only fires when a model list is
 * supplied — SYS-20260812-002).
 */
import type { AutoDevListing } from "./auto-dev-client";

const MAX_PER_MAKE_MODEL = 2;

export function applyDiversity(listings: AutoDevListing[], limit: number): AutoDevListing[] {
  const seen = new Map<string, number>();
  const result: AutoDevListing[] = [];

  for (const listing of listings) {
    const key = `${(listing.vehicle?.make ?? "").toLowerCase()}|${(listing.vehicle?.model ?? "").toLowerCase()}`;
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
