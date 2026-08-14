/**
 * Post-verification — Auto.dev silently swallows unknown/malformed params
 * and can return rows that don't actually satisfy a stated filter (real,
 * documented behavior — AUTODEV_V2_NLP_SEARCH_REDESIGN.md §3.3, §5.4 step 6).
 * This is a mechanical sanity check, never a semantic one (no size-class
 * judgment, no "large SUV" reasoning — that stays the calling LLM's job,
 * by design, per SYS-20260812-035).
 */
import type { AutoDevListing } from "./auto-dev-client";
import type { ListingsQuery } from "./auto-dev-client";

// make/model can be comma-separated OR lists (see match-score.ts for why).
// Also: model strings have real cross-API family variance (STEP3_STATUS.md,
// e.g. "Silverado 1500 Crew Cab" vs "Silverado 1500") — exact equality wrongly
// strips valid rows. Use substring/prefix tolerance instead of strict equality.
//
// String(value) wrapper (real bug found 2026-08-14, reproduced live on a
// bare "convertible" query): rare/varied vehicles from a broad, unanchored
// search can have make/model come back as a non-string type despite our own
// type declaring string - a bare .trim() then throws "not a function". Same
// bug class already found and fixed in diversity.ts this same day.
function matchesAnyInList(value: unknown, list: string): boolean {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  const options = list.split(",").map((s) => s.trim().toLowerCase());
  return options.some((opt) => v === opt || v.startsWith(opt) || opt.startsWith(v));
}

export function verifyAgainstConstraints(listing: AutoDevListing, query: ListingsQuery): string[] {
  const violations: string[] = [];
  const v = listing.vehicle;
  const rl = listing.retailListing;

  if (query.make && v?.make && !matchesAnyInList(v.make, query.make)) {
    violations.push("make");
  }
  if (query.model && v?.model && !matchesAnyInList(v.model, query.model)) {
    violations.push("model");
  }
  if (query.priceMax != null && rl?.price != null && rl.price > query.priceMax) {
    violations.push("price");
  }
  if (query.priceMin != null && rl?.price != null && rl.price < query.priceMin) {
    violations.push("price");
  }
  if (query.yearMin != null && v?.year != null && v.year < query.yearMin) {
    violations.push("year");
  }
  if (query.yearMax != null && v?.year != null && v.year > query.yearMax) {
    violations.push("year");
  }
  if (query.mileageMax != null && rl?.miles != null && rl.miles > query.mileageMax) {
    violations.push("mileage");
  }

  return violations;
}
