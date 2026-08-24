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

/**
 * Same safe-coercion discipline as safeLower() above, for VIN dedup
 * (SYS-20260827): trim + uppercase so casing/whitespace differences never
 * cause a genuine duplicate to slip through, but no other normalization
 * (no stripping of ambiguous characters, no near-match logic) — this is
 * exact-match same-VIN protection only, never fuzzy/near-duplicate
 * suppression.
 */
function safeVin(x: unknown): string {
  return String(x ?? "").trim().toUpperCase();
}

// A VIN is exactly 17 characters per the standard. Only a value at that
// exact length is trusted as a real, comparable VIN for dedup purposes —
// missing/blank/malformed values (empty string, undefined, truncated
// values, junk) must never collapse together as if they were the "same"
// vehicle. Two listings that both have an invalid/blank VIN remain fully
// independent and are never deduped against each other.
function isValidVin(vin: string): boolean {
  return vin.length === 17;
}

export function applyDiversity(listings: AutoDevListing[], limit: number): AutoDevListing[] {
  const seen = new Map<string, number>();
  // Tracks VINs that have already made it into `result` — populated only
  // when a listing is actually pushed (see below), never merely scanned.
  // This preserves the first ranked occurrence of a given VIN that
  // actually gets included (whether via the diversity pass or the
  // backfill pass) and skips any later listing object sharing that same
  // normalized 17-character VIN, without wasting a slot on a VIN that
  // was itself skipped for an unrelated reason (e.g. the make/model cap)
  // and never got included in the first place.
  const seenVins = new Set<string>();
  const result: AutoDevListing[] = [];

  for (const listing of listings) {
    const vin = safeVin(listing.vin);
    if (isValidVin(vin) && seenVins.has(vin)) continue;
    const key = `${safeLower(listing.vehicle?.make)}|${safeLower(listing.vehicle?.model)}`;
    const count = seen.get(key) ?? 0;
    if (count >= MAX_PER_MAKE_MODEL) continue;
    seen.set(key, count + 1);
    if (isValidVin(vin)) seenVins.add(vin);
    result.push(listing);
    if (result.length >= limit) break;
  }

  // Backfill if diversity capping left us short of the limit
  if (result.length < limit) {
    for (const listing of listings) {
      if (result.includes(listing)) continue;
      const vin = safeVin(listing.vin);
      if (isValidVin(vin) && seenVins.has(vin)) continue;
      result.push(listing);
      if (isValidVin(vin)) seenVins.add(vin);
      if (result.length >= limit) break;
    }
  }

  return result;
}
