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

export function verifyAgainstConstraints(listing: AutoDevListing, query: ListingsQuery): string[] {
  const violations: string[] = [];
  const v = listing.vehicle;
  const rl = listing.retailListing;

  if (query.make && v?.make && v.make.toLowerCase() !== query.make.toLowerCase()) {
    violations.push("make");
  }
  if (query.model && v?.model && v.model.toLowerCase() !== query.model.toLowerCase()) {
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
