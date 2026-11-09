/**
 * Seats disclosure (moved out of the route on 9 Nov 2026 so it can be tested; behaviour of the states is unchanged, the WORDING now says where the number comes from).
 * Same Trust Class C treatment as CPO and history: `vehicle.seats` is a real response field (NHTSA's decode), reported, never a hard filter; a below-preference or unreported seat count is
 * disclosed, not dropped. Group 2, item 4 (9 Nov 2026): the number is NHTSA's value for the model series, so cab or trim variants can differ (a Tacoma Xtra Cab showed 5 seats with 2 doors); the
 * sentence no longer reads like a confirmation, and the text puts it on its own "Seats:" line instead of under "Confirmed:". The wording is kept close to the old length because the card shows these strings as small chips.
 */
export type SeatsState = "meets_or_exceeds" | "below_requested" | "reported" | "unknown";
const SERIES = "(NHTSA series data; cab or trim can differ)";

export function buildSeatsSummary(listing: { vehicle?: { seats?: number | null } | null }, seatsMin: number | undefined): { state: SeatsState; note: string } {
  const seats = listing.vehicle?.seats;
  if (seats == null) {
    return {
      state: "unknown",
      note: seatsMin != null
        ? `Seating capacity not reported by this listing — can't confirm it meets the requested ${seatsMin}+ seats.`
        : "Seating capacity not reported by this listing.",
    };
  }
  const n = `${seats} seat${seats === 1 ? "" : "s"} ${SERIES}`;
  if (seatsMin == null) return { state: "reported", note: `${n}.` };
  if (seats >= seatsMin) return { state: "meets_or_exceeds", note: `${n}, meets the requested ${seatsMin}+.` };
  return { state: "below_requested", note: `${n}, below the requested ${seatsMin}+. Shown anyway: seats are a preference, not a filter.` };
}

/** True for the seating statements above (reported, meets, below or unreported); the text prints them on their own "Seats:" line and keeps them out of "Confirmed:". */
export const isSeatsNote = (x: string): boolean => /^\d+ seats? \(NHTSA series data/.test(x) || x.startsWith("Seating capacity not reported");
