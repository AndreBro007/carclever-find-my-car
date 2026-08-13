/**
 * Zero-result loosening ladder — adapted from the proven, live-tested design
 * in AUTODEV_V2_NLP_SEARCH_REDESIGN.md §5.4 (Sky redesign, approved July 26).
 *
 * Runs only when the initial search returns 0 (or very few) candidates.
 * Every step taken is honestly reported in `relaxations` — never silent
 * (SYS-20260812-011 #3, now actually implemented rather than just designed).
 *
 * Ladder order (most-restrictive-first, budget preserved until last resort):
 *   0. ZIP guard — a non-geocodable ZIP returns 0 with HTTP 200, not an
 *      error (real documented failure mode, §3.2). Retry with a much wider
 *      radius; if still 0, drop location entirely and disclose nationwide scope.
 *   1. widen year range ±2
 *   2. widen radius (if not already widened by the ZIP guard)
 *   3. widen mileage ceiling +30%, then drop entirely
 *   4. widen price ceiling +15% — ONLY if priceFlexibility is "flexible";
 *      never touched on "strict" (budget is sacred, per the redesign doc)
 *
 * Trim and seats are never part of this ladder — they were never sent as
 * hard filters in the first place (SYS-20260812-023/025).
 */
import { searchListings, type ListingsQuery, type ListingsResponse } from "./auto-dev-client";

export interface Relaxation {
  step: string;
  detail: string;
}

export interface LoosenedSearchResult extends ListingsResponse {
  relaxations: Relaxation[];
  scopeNote: "local" | "nationwide";
}

const MIN_ACCEPTABLE = 3; // run the ladder if fewer than this many candidates come back

export async function searchWithLoosening(
  baseQuery: ListingsQuery,
  priceFlexibility: "strict" | "flexible" = "strict",
): Promise<LoosenedSearchResult> {
  const relaxations: Relaxation[] = [];
  let scopeNote: "local" | "nationwide" = "local";
  let query = { ...baseQuery };

  let result = await searchListings(query);
  if (result.data.length >= MIN_ACCEPTABLE) {
    return { ...result, relaxations, scopeNote };
  }

  // Step 0 — ZIP guard
  if (query.zip) {
    const widerRadius = { ...query, radius: 500 };
    const retry = await searchListings(widerRadius);
    if (retry.data.length >= MIN_ACCEPTABLE) {
      relaxations.push({
        step: "zip_guard",
        detail: `Widened search radius to 500 miles from ZIP ${query.zip} — fewer than ${MIN_ACCEPTABLE} matches within the original radius.`,
      });
      return { ...retry, relaxations, scopeNote };
    }
    // Still nothing — the ZIP itself may not be geocodable at all (real,
    // documented failure: silently returns 0 with HTTP 200, not an error).
    const { zip, radius, ...withoutLocation } = query;
    const nationwide = await searchListings(withoutLocation);
    if (nationwide.data.length > 0) {
      relaxations.push({
        step: "zip_guard",
        detail: `ZIP ${zip} returned no matches even at a 500-mile radius — it may not be recognized. Widened to nationwide.`,
      });
      scopeNote = "nationwide";
      query = withoutLocation;
      result = nationwide;
      if (result.data.length >= MIN_ACCEPTABLE) return { ...result, relaxations, scopeNote };
    }
  }

  // Step 1 — widen year range ±2
  if (query.yearMin != null || query.yearMax != null) {
    const widened = {
      ...query,
      yearMin: query.yearMin != null ? query.yearMin - 2 : undefined,
      yearMax: query.yearMax != null ? query.yearMax + 2 : undefined,
    };
    const retry = await searchListings(widened);
    if (retry.data.length > result.data.length) {
      relaxations.push({
        step: "year_range",
        detail: `Widened year range by ±2 years — too few matches in the exact requested range.`,
      });
      query = widened;
      result = retry;
      if (result.data.length >= MIN_ACCEPTABLE) return { ...result, relaxations, scopeNote };
    }
  }

  // Step 2 — widen radius further (only if not already handled by the ZIP guard)
  if (query.zip && (query.radius ?? 50) < 250 && scopeNote === "local") {
    const widened = { ...query, radius: 250 };
    const retry = await searchListings(widened);
    if (retry.data.length > result.data.length) {
      relaxations.push({ step: "radius", detail: `Widened search radius to 250 miles.` });
      query = widened;
      result = retry;
      if (result.data.length >= MIN_ACCEPTABLE) return { ...result, relaxations, scopeNote };
    }
  }

  // Step 3 — widen mileage ceiling, then drop
  if (query.mileageMax != null) {
    const widened = { ...query, mileageMax: Math.round(query.mileageMax * 1.3) };
    let retry = await searchListings(widened);
    if (retry.data.length > result.data.length) {
      relaxations.push({
        step: "mileage",
        detail: `Widened mileage ceiling by 30% (to ${widened.mileageMax.toLocaleString()} mi).`,
      });
      query = widened;
      result = retry;
    }
    if (result.data.length < MIN_ACCEPTABLE) {
      const { mileageMax, ...dropped } = query;
      retry = await searchListings(dropped);
      if (retry.data.length > result.data.length) {
        relaxations.push({ step: "mileage", detail: `Dropped mileage limit entirely.` });
        query = dropped;
        result = retry;
      }
    }
    if (result.data.length >= MIN_ACCEPTABLE) return { ...result, relaxations, scopeNote };
  }

  // Step 4 — widen price ceiling, ONLY if explicitly flagged flexible. Never
  // touched on strict — budget is the most sensitive constraint (redesign
  // doc §5.4 step 5, "never silently on strict").
  if (query.priceMax != null && priceFlexibility === "flexible") {
    const widened = { ...query, priceMax: Math.round(query.priceMax * 1.15) };
    const retry = await searchListings(widened);
    if (retry.data.length > result.data.length) {
      relaxations.push({
        step: "price",
        detail: `Widened price ceiling by 15% (to $${widened.priceMax.toLocaleString()}) — you indicated some flexibility on budget.`,
      });
      query = widened;
      result = retry;
    }
  }

  return { ...result, relaxations, scopeNote };
}
