/**
 * R4-5 BEST VALUE (10 Nov 2026; André's decisions SYS-20261110-012 to -023, design: getcarwise-docs DESIGN_R4_5_BEST_VALUE_20261110.md).
 * A separate ranking, used only when the shopper asks for value. best_for_budget stays the default and is not touched.
 *
 * Value = (typical asking price of similar listings minus this car's asking price) / typical, as a percentage. Below zero means ABOVE typical. It is an asking-price
 * comparison inside our own catalogue: not reliability, condition, history or a guaranteed saving.
 *
 * Similar cars: same make, model, model year and trim (exact text; the year is never widened and the trim never dropped), the same condition (new and used are kept apart),
 * OTHER vehicles only (distinct VINs; the car itself is excluded), prices at or above the anomaly floor. Used cars: mileage within +/-20 percent, then +/-35, then +/-50 percent
 * of the car's mileage (cars under 1,000 miles or with no mileage are not scored). New cars: no mileage range. The shopper's price ceiling limits the cars RETURNED, never the comparables.
 * Area: the search's own area first (with its mileage steps); only if there are fewer than eight similar cars, the comparison area widens to 100, 200, 500 miles, then nationwide
 * (the mileage steps restart at each area). The area used is always stated.
 * At least EIGHT usable comparables (after the Deal Score outlier rule) are needed; 8 to 14 are flagged as a limited sample. A car priced more than 40 percent below typical is
 * NOT ranked (shown after the ranked cars, marked as unusually low). Cars that cannot be judged come last. Ties: lower mileage, newer, lower price, then the VIN.
 */
import type { VehicleListing } from "./listing-types";
import { alnumKey } from "./catalog-db/normalize";

export const VALUE_MIN_COMPARABLES = 8;
export const VALUE_GOOD_SAMPLE = 15; // 8 to 14 usable comparables: limited sample
export const VALUE_SUSPECT_FRACTION = 0.4; // more than 40 percent below typical: not ranked
export const VALUE_MILEAGE_BANDS = [0.2, 0.35, 0.5] as const;
export const VALUE_AREA_STEPS_MILES = [100, 200, 500] as const; // after the search's own area; then nationwide
export const VALUE_MIN_USED_MILES = 1000;
export const VALUE_PRICE_FLOOR = 1000; // same floor as the anomalous-price rule
export const VALUE_POOL_BOUND = 600; // the nearest 600 local candidates are scored

export interface ValueSubject {
  vin: string; makeKey: string; modelKey: string; year: number | null; trim: string | null; used: boolean | null;
  price: number | null; miles: number | null; distance: number | null;
}
export interface Comparable {
  vin: string; makeKey: string; modelKey: string; year: number; trim: string; used: boolean; price: number; miles: number | null; distance: number;
}
export type ValueUnscoredReason = "missing_details" | "mileage_unknown" | "mileage_under_1000" | "too_few_similar";
export interface ValueScore {
  vin: string;
  status: "ranked" | "unusually_low" | "unscored";
  /** (typical - price) / typical, as a fraction; negative = above typical. */
  value?: number;
  typical?: number;
  sample?: number;
  limitedSample?: boolean;
  /** Miles from the search origin that bounded the comparison, or null for nationwide. */
  areaMiles?: number | null;
  mileageBand?: number | null;
  reason?: ValueUnscoredReason;
}

/** Deal Score outlier rule (carclever-widget lib/dealScore.ts filterOutliers), reproduced exactly. */
export function filterOutliers(prices: number[]): number[] {
  if (prices.length < 4) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  return sorted.filter((p) => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
}
export function median(prices: number[]): number {
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const keyOf = (mk: string, md: string, year: number, trim: string, used: boolean): string => `${mk}|${md}|${year}|${trim}|${used ? "u" : "n"}`;

/** The areas to try, in order: the search's own radius, then 100, 200, 500 miles (only those larger), then nationwide (null). */
export function areaLadder(searchRadiusMiles: number): Array<number | null> {
  const r = Number.isFinite(searchRadiusMiles) && searchRadiusMiles > 0 ? searchRadiusMiles : 50;
  const out: Array<number | null> = [r];
  for (const a of VALUE_AREA_STEPS_MILES) if (a > r) out.push(a);
  out.push(null);
  return out;
}

export type ComparableIndex = Map<string, Comparable[]>;
export function indexComparables(comps: Comparable[]): ComparableIndex {
  const m: ComparableIndex = new Map();
  for (const c of comps) { const k = keyOf(c.makeKey, c.modelKey, c.year, c.trim, c.used); const a = m.get(k); if (a) a.push(c); else m.set(k, [c]); }
  return m;
}

/** What blocks a car from being judged at all (before any comparison), or null. */
export function unscorableReason(s: ValueSubject): ValueUnscoredReason | null {
  if (s.year == null || !s.trim || s.used == null || s.price == null || !(s.price >= VALUE_PRICE_FLOOR)) return "missing_details";
  if (s.used) { if (s.miles == null) return "mileage_unknown"; if (s.miles < VALUE_MIN_USED_MILES) return "mileage_under_1000"; }
  return null;
}

export function scoreSubject(s: ValueSubject, index: ComparableIndex, searchRadiusMiles: number): ValueScore {
  const blocked = unscorableReason(s);
  if (blocked) return { vin: s.vin, status: "unscored", reason: blocked };
  const group = index.get(keyOf(s.makeKey, s.modelKey, s.year as number, s.trim as string, s.used as boolean)) ?? [];
  const others = group.filter((c) => c.vin !== s.vin && c.price >= VALUE_PRICE_FLOOR && (!s.used || (c.miles != null && c.miles >= VALUE_MIN_USED_MILES)));
  for (const area of areaLadder(searchRadiusMiles)) {
    const inArea = area == null ? others : others.filter((c) => c.distance <= area);
    const bands: Array<number | null> = s.used ? [...VALUE_MILEAGE_BANDS] : [null];
    for (const band of bands) {
      const pool = band == null ? inArea : inArea.filter((c) => Math.abs((c.miles as number) - (s.miles as number)) <= band * (s.miles as number));
      const usable = filterOutliers(pool.map((c) => c.price));
      if (usable.length >= VALUE_MIN_COMPARABLES) {
        const typical = median(usable);
        const value = (typical - (s.price as number)) / typical;
        return {
          vin: s.vin, status: value > VALUE_SUSPECT_FRACTION ? "unusually_low" : "ranked", value, typical, sample: usable.length,
          limitedSample: usable.length < VALUE_GOOD_SAMPLE, areaMiles: area, mileageBand: band,
        };
      }
    }
  }
  return { vin: s.vin, status: "unscored", reason: "too_few_similar" };
}

export interface ValueRanking { order: string[]; scores: Map<string, ValueScore> }

/** Order: ranked cars (value high to low), then the unusually low ones, then the cars that could not be judged (nearest first). Stable and identical on every run (VIN last). */
export function orderByValue(subjects: ValueSubject[], scores: Map<string, ValueScore>): string[] {
  const subj = new Map(subjects.map((s) => [s.vin, s]));
  const milesOf = (s: ValueSubject): number => (s.miles == null ? 0 : s.miles);
  const byValue = (a: ValueSubject, b: ValueSubject): number => {
    const va = (scores.get(a.vin)?.value ?? 0), vb = (scores.get(b.vin)?.value ?? 0);
    return vb - va || milesOf(a) - milesOf(b) || (b.year ?? 0) - (a.year ?? 0) || (a.price ?? 0) - (b.price ?? 0) || a.vin.localeCompare(b.vin);
  };
  const pick = (st: ValueScore["status"]) => subjects.filter((s) => scores.get(s.vin)?.status === st);
  const ranked = pick("ranked").sort(byValue);
  const low = pick("unusually_low").sort(byValue);
  const unscored = pick("unscored").sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9) || a.vin.localeCompare(b.vin));
  return [...ranked, ...low, ...unscored].map((s) => s.vin).filter((v) => subj.has(v));
}

export function rankByValue(subjects: ValueSubject[], comps: Comparable[], searchRadiusMiles: number): ValueRanking {
  const index = indexComparables(comps);
  const scores = new Map<string, ValueScore>();
  for (const s of subjects) scores.set(s.vin, scoreSubject(s, index, searchRadiusMiles));
  return { order: orderByValue(subjects, scores), scores };
}

/** A search result row as a value subject. */
export function subjectOf(l: VehicleListing): ValueSubject {
  const v = l.vehicle ?? {}, r = l.retailListing ?? {};
  const d = (l as { catalog?: { distanceMiles?: number } }).catalog?.distanceMiles;
  return {
    vin: String(l.vin ?? "").trim().toUpperCase(), makeKey: alnumKey(String(v.make ?? "")), modelKey: alnumKey(String(v.model ?? "")),
    year: typeof v.year === "number" ? v.year : null, trim: v.trim ? String(v.trim) : null, used: typeof r.used === "boolean" ? r.used : null,
    price: typeof r.price === "number" ? r.price : null, miles: typeof r.miles === "number" ? r.miles : null, distance: typeof d === "number" ? d : null,
  };
}

/** The (make, model, year, trim, condition) groups whose comparables are needed for these subjects. */
export function groupsNeeded(subjects: ValueSubject[]): Array<{ makeKey: string; modelKey: string; year: number; trim: string; used: boolean }> {
  const seen = new Map<string, { makeKey: string; modelKey: string; year: number; trim: string; used: boolean }>();
  for (const s of subjects) if (!unscorableReason(s)) seen.set(keyOf(s.makeKey, s.modelKey, s.year as number, s.trim as string, s.used as boolean), { makeKey: s.makeKey, modelKey: s.modelKey, year: s.year as number, trim: s.trim as string, used: s.used as boolean });
  return [...seen.values()];
}

export type ComparablesFetch = (groups: ReturnType<typeof groupsNeeded>, maxRadiusMiles: number | null) => Promise<Comparable[]>;

/**
 * Two steps at most: comparables inside the search area first (small); only for groups where some car lacks eight similar cars there, one more fetch without an area limit,
 * then the same scoring over everything fetched (the area steps are applied in memory by distance).
 */
export async function rankListingsByValue(listings: VehicleListing[], searchRadiusMiles: number, fetchComparables: ComparablesFetch): Promise<ValueRanking & { widenedFetch: boolean }> {
  const subjects = listings.map(subjectOf);
  const first = await fetchComparables(groupsNeeded(subjects), areaLadder(searchRadiusMiles)[0]);
  let ranking = rankByValue(subjects, first, searchRadiusMiles);
  const short = subjects.filter((s) => ranking.scores.get(s.vin)?.reason === "too_few_similar");
  if (short.length === 0) return { ...ranking, widenedFetch: false };
  const wide = await fetchComparables(groupsNeeded(short), null);
  const byKey = new Map<string, Comparable>();
  for (const c of [...first, ...wide]) byKey.set(`${c.vin}`, c);
  ranking = rankByValue(subjects, [...byKey.values()], searchRadiusMiles);
  return { ...ranking, widenedFetch: true };
}

/** Plain words for one car (reply text only; the card is not changed). */
export function valueLineFor(sc: ValueScore | undefined): string {
  if (!sc) return "";
  if (sc.status === "unscored") {
    const why = sc.reason === "mileage_under_1000" ? "mileage under 1,000 miles, so not compared by mileage" : sc.reason === "mileage_unknown" ? "mileage not listed" : sc.reason === "missing_details" ? "year, trim or price not listed" : "fewer than eight similar listings found";
    return `Value: not judged (${why}).`;
  }
  const pct = Math.round(Math.abs((sc.value as number) * 100) * 10) / 10;
  const dir = (sc.value as number) >= 0 ? `${pct}% below` : `${pct}% above`;
  const area = sc.areaMiles == null ? "nationwide" : `within ${sc.areaMiles} miles`;
  const band = sc.mileageBand == null ? "" : `, mileage within ${Math.round(sc.mileageBand * 100)}%`;
  const basis = `${sc.sample} similar listings ${area}${band}${sc.limitedSample ? ", limited sample" : ""}`;
  if (sc.status === "unusually_low") return `Value: ${dir} the typical asking price (${basis}). Price looks unusually low: check with the dealer. Not ranked on value.`;
  return `Value: ${dir} the typical asking price (${basis}).`;
}
