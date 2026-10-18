/**
 * Pure candidate-ordering/disclosure logic, extracted from
 * app/[transport]/route.ts specifically so it can be
 * unit-tested with real functional assertions on real VehicleListing
 * fixtures — Next.js Route Handler files only permit a fixed set of named
 * exports (GET/POST/etc + a few config options), so these functions could
 * not be exported and imported directly from route.ts itself (confirmed by
 * a real local build failure this session: "X is not a valid Route export
 * field"). This file has zero framework dependency and is safe to import
 * from anywhere, including test files.
 *
 * route.ts imports every function/constant here instead of defining its own
 * copy — there is exactly one implementation, not a synchronized pair that
 * could drift.
 */

import { type VehicleListing } from "@/lib/listing-types";
import { trimMatches } from "@/lib/trim-match";

// Shared anomalous-price rule (feature/value-based-best-for-budget follow-up):
// hoisted here so the "price-likely-inaccurate" card badge (route.ts) and the
// best_for_budget ranking's price weighting (below) both read the exact same
// threshold/definition — cannot drift into two independent $1,000 rules.
// Real evidence (Aug 14) that motivated the original badge: a listing priced
// $85 for a 2024 CR-V passed every filter cleanly and got VIN-verified — the
// price itself is the obviously bad data, not the identity.
export const ANOMALOUS_PRICE_FLOOR = 1000;
export function isAnomalousPrice(price: number | undefined | null): boolean {
  return price != null && price < ANOMALOUS_PRICE_FLOOR;
}

export function buildCpoSummary(
  listing: VehicleListing,
): { state: "confirmed_cpo" | "reported_not_cpo" | "unknown"; note: string } {
  const cpo = listing.retailListing?.cpo;
  if (cpo === true) {
    return { state: "confirmed_cpo", note: "Reported as Certified Pre-Owned by the dealer." };
  }
  if (cpo === false) {
    return {
      state: "reported_not_cpo",
      note: "Not reported as CPO by this listing — this isn't definitive proof it lacks certification, just that it wasn't flagged as one.",
    };
  }
  return { state: "unknown", note: "CPO status not reported for this listing." };
}

export function buildHistorySummary(
  listing: VehicleListing,
): { state: "known_clean" | "known_issues" | "unreported"; note: string; ownerNote: string | null } {
  const h = listing.history;
  const carfaxAvailable = Boolean(listing.retailListing?.carfaxUrl);
  const carfaxHint = carfaxAvailable
    ? " The Carfax link on this result is the way to independently confirm."
    : " No Carfax link was available on this listing to independently confirm.";

  let ownerNote: string | null = null;
  if (h?.ownerCount != null) {
    ownerNote = `Reported ${h.ownerCount} owner${h.ownerCount === 1 ? "" : "s"} in this listing's history.`;
  } else if (h?.oneOwner === true) {
    ownerNote = "Reported as a one-owner vehicle.";
  } else if (h?.oneOwner === false) {
    ownerNote = "Not reported as one-owner — not definitive proof of multiple owners, just not flagged as one-owner.";
  }

  if (!h || (h.accidentCount == null && h.accidents == null)) {
    return {
      state: "unreported",
      note: `Accident history was not reported for this listing — this is common (roughly half of listings), not a red flag by itself.${carfaxHint}`,
      ownerNote,
    };
  }

  const accidentCount = h.accidentCount ?? (h.accidents ? 1 : 0);
  if (accidentCount > 0) {
    return {
      state: "known_issues",
      note: `Reported ${accidentCount} accident${accidentCount === 1 ? "" : "s"} in this listing's history.${carfaxHint}`,
      ownerNote,
    };
  }

  return {
    state: "known_clean",
    note: "No accidents reported in this listing's history (single-source; not an independent guarantee).",
    ownerNote,
  };
}

/**
 * EXPERIMENT (preview only, SYS-20260825 follow-up): local best_for_budget
 * candidate ordering. Provider retrieval/sort is completely untouched — this
 * only reorders the already-eligible lean candidates client-side. cheapest/
 * lowest_mileage/newest are untouched — this function is never called for
 * those axes.
 *
 * electrificationMatchOf (electrificationRequirement:
 * "preferred"): confirmed match sorts first, but ONLY as a tiebreaker BELOW
 * the real balancedScore comparison — deliberately placed after scoreDiff,
 * not alongside trimMatchRank at the top, so a genuinely better price/
 * mileage/year candidate is never displaced by a worse one that merely
 * happens to be electrified. Absent electrificationMatchOf (no preferred
 * electrification requested), this key is always 0 for every candidate and
 * has zero effect — existing best_for_budget behavior for every other
 * search is unchanged.
 */
export function applyLocalBestForBudgetOrdering(
  candidates: VehicleListing[],
  trimPreference: string | undefined,
  electrificationMatchOf?: (c: VehicleListing) => boolean,
  priceCap?: number,
): VehicleListing[] {
  if (candidates.length === 0) return candidates;

  const years = candidates.map((c) => c.vehicle?.year).filter((y): y is number => y != null);
  const miles = candidates.map((c) => c.retailListing?.miles).filter((m): m is number => m != null);
  const genuinePrices = candidates
    .map((c) => c.retailListing?.price)
    .filter((p): p is number => p != null && !isAnomalousPrice(p));
  const yearMin = years.length > 0 ? Math.min(...years) : null;
  const yearMax = years.length > 0 ? Math.max(...years) : null;
  const milesMin = miles.length > 0 ? Math.min(...miles) : null;
  const milesMax = miles.length > 0 ? Math.max(...miles) : null;
  const priceMin = genuinePrices.length > 0 ? Math.min(...genuinePrices) : null;
  const priceMax = genuinePrices.length > 0 ? Math.max(...genuinePrices) : null;

  const yearRank = (y: number | undefined): number => {
    if (y == null || yearMin == null || yearMax == null || yearMax === yearMin) return 0.5;
    return (y - yearMin) / (yearMax - yearMin);
  };
  const mileageRank = (m: number | undefined): number => {
    if (m == null || milesMin == null || milesMax == null || milesMax === milesMin) return 0.5;
    return (milesMax - m) / (milesMax - milesMin);
  };
  const priceRank = (c: VehicleListing): number => {
    const p = c.retailListing?.price;
    if (isAnomalousPrice(p)) return 0.5;
    if (p == null || priceMin == null || priceMax == null || priceMax === priceMin) return 0.5;
    return (priceMax - p) / (priceMax - priceMin);
  };
  // With a stated price ceiling the buyer wants the best car UP TO that ceiling, not the cheapest one: year and mileage
  // carry most of the weight, and a price closer to the ceiling scores higher (cheaper is not better by itself).
  // Without a ceiling the earlier equal-weight score (cheaper ranks higher) is unchanged.
  const hasCap = priceCap != null && Number.isFinite(priceCap) && priceCap > 0;
  const budgetUseRank = (c: VehicleListing): number => {
    const p = c.retailListing?.price;
    if (p == null || isAnomalousPrice(p)) return 0.5;
    return Math.min(Math.max(p / (priceCap as number), 0), 1);
  };
  const balancedScore = (c: VehicleListing): number =>
    hasCap
      ? 0.4 * yearRank(c.vehicle?.year) + 0.4 * mileageRank(c.retailListing?.miles) + 0.2 * budgetUseRank(c)
      : (yearRank(c.vehicle?.year) + mileageRank(c.retailListing?.miles) + priceRank(c)) / 3;
  const trimMatchRank = (c: VehicleListing): number =>
    trimPreference && trimMatches(trimPreference, c.vehicle?.trim) ? 0 : 1;
  const anomalyRank = (c: VehicleListing): number => (isAnomalousPrice(c.retailListing?.price) ? 1 : 0);
  const electrificationMatchRank = (c: VehicleListing): number =>
    electrificationMatchOf && electrificationMatchOf(c) ? 0 : 1;

  return [...candidates].sort((a, b) => {
    const trimDiff = trimMatchRank(a) - trimMatchRank(b);
    if (trimDiff !== 0) return trimDiff;

    const anomalyDiff = anomalyRank(a) - anomalyRank(b);
    if (anomalyDiff !== 0) return anomalyDiff;

    const scoreDiff = balancedScore(b) - balancedScore(a);
    if (scoreDiff !== 0) return scoreDiff;

    const electrificationDiff = electrificationMatchRank(a) - electrificationMatchRank(b);
    if (electrificationDiff !== 0) return electrificationDiff;

    const priceA = a.retailListing?.price ?? Infinity;
    const priceB = b.retailListing?.price ?? Infinity;
    if (priceA !== priceB) return priceA - priceB;

    return 0;
  });
}

