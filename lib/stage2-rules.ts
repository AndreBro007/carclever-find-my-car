/** Stage-2 rules shared by the search and by Show 8 more (R4-6 step 4a, 11 Nov 2026): moved out of the search handler WITHOUT any change of logic, so both run the same code. */
import type { VehicleListing } from "./listing-types";

/**
 * Body-style re-check on the full detail (SYS-20260816-052). String()-coerced before lower-casing: a present-but-wrong-type value from the feed must never crash and never match by accident.
 * A listing that reports neither style nor type passes (unknown is never a mismatch).
 */
export function bodyStyleMatches(targetRaw: string, c: VehicleListing): boolean {
  const target = targetRaw.toLowerCase();
  const reportedStyle = c.vehicle?.bodyStyle != null ? String(c.vehicle.bodyStyle).toLowerCase() : null;
  const reportedType = c.vehicle?.type != null ? String(c.vehicle.type).toLowerCase() : null;
  if (reportedStyle == null && reportedType == null) return true;
  return reportedStyle === target || reportedType === target;
}
