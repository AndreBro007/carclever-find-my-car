// Explicit shopping objectives (André, 19 Oct 2026, option A): when the buyer asks for the cheapest, newest or lowest-mileage cars,
// the result is the globally best cars in exactly that order. The variety rule (at most two per make and model) is for the open
// "best for budget" search only; applying it here left cheaper cars out and could put a dearer or older car first.
import type { VehicleListing } from "./listing-types";

export type StrictAxis = "cheapest" | "newest" | "lowest_mileage";

export function isStrictAxis(a: unknown): a is StrictAxis {
  return a === "cheapest" || a === "newest" || a === "lowest_mileage";
}

const num = (v: unknown, missing: number): number => (typeof v === "number" && Number.isFinite(v) ? v : missing);

function compare(axis: StrictAxis) {
  const price = (l: VehicleListing) => num(l.retailListing?.price, Number.POSITIVE_INFINITY);
  const miles = (l: VehicleListing) => num(l.retailListing?.miles, Number.POSITIVE_INFINITY);
  const year = (l: VehicleListing) => num(l.vehicle?.year, Number.NEGATIVE_INFINITY);
  // A car with no value for the sorted field goes after every car that has one; ties fall to the next most useful field.
  switch (axis) {
    case "cheapest": return (a: VehicleListing, b: VehicleListing) => price(a) - price(b) || miles(a) - miles(b) || year(b) - year(a);
    case "newest": return (a: VehicleListing, b: VehicleListing) => year(b) - year(a) || miles(a) - miles(b) || price(a) - price(b);
    case "lowest_mileage": return (a: VehicleListing, b: VehicleListing) => miles(a) - miles(b) || price(a) - price(b) || year(b) - year(a);
  }
}

/** The comparator behind `strictAxisOrder`, for re-applying an explicit objective inside a later grouping (review R3-02). */
export const axisComparator = compare;

const cleanVin = (v: unknown): string => String(v ?? "").trim().toUpperCase();

/** The best `limit` cars for the axis, strictly ordered. The same VIN listed twice counts once (first in the sorted order). */
export function strictAxisOrder<T extends VehicleListing>(listings: T[], axis: StrictAxis, limit: number): T[] {
  const cmp = compare(axis);
  const sorted = listings.map((l, i) => ({ l, i })).sort((x, y) => cmp(x.l, y.l) || x.i - y.i).map((x) => x.l);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of sorted) {
    const vin = cleanVin(l.vin);
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) { if (seen.has(vin)) continue; seen.add(vin); }
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}
