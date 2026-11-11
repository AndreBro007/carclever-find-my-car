/**
 * R4-6 step 4a (11 Nov 2026): checking ONE reserve car at expansion time, with the same rules the first search applies at its detail stage (design sections 4 and 5).
 * The rules are the search's own library functions (verifyAgainstConstraints, trimMatchesAny / trimContainsAllAny, bodyStyleMatches); nothing is copied.
 * Outcomes follow the design table: found and fine -> a numbered slot; verified evidence against the search -> excluded with one fixed reason; the detail read FAILED -> pending (never excluded).
 */
import type { VehicleListing, ListingsQuery } from "../listing-types";
import { verifyAgainstConstraints } from "../post-verify";
import { trimMatchesAny, trimContainsAllAny } from "../trim-match";
import { bodyStyleMatches } from "../stage2-rules";
import { starsOf } from "./first-search";
import type { Outcome, ReserveEntry } from "./slate";
import type { Requirements } from "./requirements";

export type VinLookupResult = { status: "found"; listing: VehicleListing } | { status: "absent" } | { status: "error" };
export interface EvalDeps {
  lookup: (vin: string) => Promise<VinLookupResult>;
  /** NHTSA 5-star overall rating for the car: a number, or undefined when not rated or not reachable. Cached and time-boxed by the caller; never throws. */
  rate: (listing: VehicleListing) => Promise<number | undefined>;
}

/** The hard limits, in the shape the search's own check reads. */
export function constraintsQuery(req: Requirements): ListingsQuery {
  return { make: req.make, model: req.models?.join(","), priceMin: req.priceMin, priceMax: req.priceMax, yearMin: req.yearMin, yearMax: req.yearMax, mileageMax: req.mileageMax } as ListingsQuery;
}

export async function evaluateReserveCar(entry: ReserveEntry, req: Requirements, deps: EvalDeps): Promise<Outcome> {
  let found: VinLookupResult;
  try { found = await deps.lookup(entry.vin); } catch { return { kind: "pending" }; }
  if (found.status === "error") return { kind: "pending" };
  if (found.status === "absent") return { kind: "exclude", reason: "removed" };
  const l = found.listing;
  const price = l.retailListing?.price;
  if (typeof price !== "number" || !Number.isFinite(price)) return { kind: "exclude", reason: "removed" }; // no usable price: nothing to freeze
  if (verifyAgainstConstraints(l, constraintsQuery(req)).length > 0) return { kind: "exclude", reason: "limit_break" };
  const used = l.retailListing?.used;
  if (req.condition && typeof used === "boolean" && (req.condition === "used") !== used) return { kind: "exclude", reason: "contradicted_filter" };
  if (req.droppedBodyStyle && !bodyStyleMatches(req.droppedBodyStyle, l)) return { kind: "exclude", reason: "contradicted_filter" };
  if (req.trimRequired?.length) {
    const required = req.trimRequired.join(", ");
    const opts = { electrified: (req.electrificationTypes?.length ?? 0) > 0 };
    const ok = req.relaxations?.includes("trim_close") ? trimContainsAllAny(required, l.vehicle?.trim, opts) : trimMatchesAny(required, l.vehicle?.trim, opts);
    if (!ok) return { kind: "exclude", reason: "contradicted_filter" };
  }
  let rating: number | undefined;
  try { rating = await deps.rate(l); } catch { rating = undefined; }
  return { kind: "pass", slot: { vin: entry.vin, price: Math.round(price), drive: entry.drive, fuel: entry.fuel, stars: starsOf(rating) } };
}
